import express from 'express';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import config from '../config/index.js';
import { resolveTenantPath, SecurityError } from '../utils/pathSanitizer.js';
import { createFileRecord, getFileMetadata, touchFileAccess } from '../services/metadataService.js';
import { execute as singleflightExecute } from '../services/singleflightService.js';
import { touchFile } from '../services/evictionService.js';
import { uploadFileToS3, downloadFileFromS3, restoreGlacierObject } from '../services/s3Service.js';
import { addS3UploadJob } from '../services/queueService.js';
import { getRedisClient } from '../db/redis.js';
import { query } from '../db/mysql.js';
import { authenticateTenant } from '../middleware/authMiddleware.js';
import { hasPermission as checkRolePermission } from '../services/authService.js';

const router = express.Router();

/**
 * Transparent Storage Proxy Route
 * PUT/POST /proxy/:tenantId/* - Proxy Upload
 */
router.all('/:tenantId/*', authenticateTenant, async (req, res) => {
  const tenantId = req.user?.tenantId || req.params.tenantId;
  const userRequestedPath = req.params[0];

  if (!tenantId) {
    return res.status(400).json({ error: 'Missing tenant ID in URL path' });
  }

  if (!userRequestedPath) {
    return res.status(400).json({ error: 'Missing file path in URL' });
  }

  const userRole = req.user?.role || 'VIEWER';

  // Handle Proxy Upload (PUT or POST)
  if (req.method === 'PUT' || req.method === 'POST') {
    if (!checkRolePermission(userRole, 'write')) {
      return res.status(403).json({ error: `Forbidden: Role '${userRole}' cannot perform write uploads` });
    }
    try {
      const fileName = path.basename(userRequestedPath);

      const maxUploadBytes = config.storage.maxUploadSizeBytes;
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (maxUploadBytes && contentLength > maxUploadBytes) {
        return res.status(413).json({ error: `File too large. Maximum upload size is ${maxUploadBytes} bytes.` });
      }

      // 1. Path sanitization
      const targetLocalPath = resolveTenantPath(tenantId, userRequestedPath);
      await fs.promises.mkdir(path.dirname(targetLocalPath), { recursive: true });

      // 2. Stream HTTP body through proxy to local disk
      await pipeline(req, fs.createWriteStream(targetLocalPath));
      const stat = await fs.promises.stat(targetLocalPath);
      const totalSizeBytes = stat.size;

      const normalizedRelPath = userRequestedPath.replace(/^(\/|\\)+/, '');
      const s3Key = `tenants/${tenantId}/${normalizedRelPath}`;

      // 3. Record Metadata in MySQL
      const fileRecord = await createFileRecord(
        tenantId,
        userRequestedPath,
        fileName,
        totalSizeBytes,
        s3Key
      );

      // 4. Background Proxy Pipe to S3 Hot Bucket via BullMQ Queue
      addS3UploadJob({ tenantId, filePath: userRequestedPath, targetLocalPath, s3Key })
        .then((jobResult) => {
          if (jobResult.status === 'FALLBACK_INLINE') {
            uploadFileToS3(s3Key, targetLocalPath, config.s3.hotBucket).catch(() => {});
          }
        })
        .catch(() => {
          uploadFileToS3(s3Key, targetLocalPath, config.s3.hotBucket).catch(() => {});
        });

      // 5. Update Redis LRU
      const redis = getRedisClient();
      touchFile(redis, `${tenantId}:${userRequestedPath}`).catch(() => {});

      return res.status(201).json({
        proxyStatus: 'SUCCESS',
        mode: 'WRITE_THROUGH_PROXY',
        file: fileRecord,
      });
    } catch (err) {
      if (err instanceof SecurityError) {
        return res.status(err.statusCode || 403).json({ error: err.message });
      }
      console.error('[Proxy Upload Error]:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Handle Proxy Download (GET)
  if (req.method === 'GET') {
    if (!checkRolePermission(userRole, 'read')) {
      return res.status(403).json({ error: `Forbidden: Role '${userRole}' cannot perform downloads` });
    }
    try {
      // 1. Path Sanitization Check
      const targetLocalPath = resolveTenantPath(tenantId, userRequestedPath);

      // 2. Query MySQL Metadata
      const metadata = await getFileMetadata(tenantId, userRequestedPath);
      if (!metadata) {
        return res.status(404).json({ error: 'File not found in storage proxy' });
      }

      // Record access metric
      touchFileAccess(tenantId, userRequestedPath).catch(() => {});

      const redis = getRedisClient();
      const fileKey = `${tenantId}:${userRequestedPath}`;
      let cacheState = 'CACHE_HIT';

      // Check local disk file
      let localExists = false;
      try {
        await fs.promises.access(targetLocalPath);
        localExists = true;
      } catch {
        localExists = false;
      }

      if (!localExists) {
        // Cache Miss: Check Storage Tier (HOT vs COLD)
        if (metadata.currentTier === 'COLD') {
          restoreGlacierObject(metadata.s3Key, config.s3.coldBucket).catch(() => {});
          return res.status(202).json({
            status: 'archived',
            message: 'File is being restored from Glacier cold storage. Available in local cache within 3-5 hours.',
            s3Key: metadata.s3Key,
          });
        }

        cacheState = 'CACHE_MISS_S3_FETCH';
        console.log(`[Proxy Cache Miss] ${fileKey} missing locally. Fetching via Singleflight S3 Proxy...`);
        await singleflightExecute(fileKey, async () => {
          const s3Data = await downloadFileFromS3(metadata.s3Key, config.s3.hotBucket);
          await fs.promises.mkdir(path.dirname(targetLocalPath), { recursive: true });
          await fs.promises.writeFile(targetLocalPath, s3Data);
          touchFile(redis, fileKey).catch(() => {});
        });
      } else {
        touchFile(redis, fileKey).catch(() => {});
      }

      const stat = await fs.promises.stat(targetLocalPath);
      const totalSizeBytes = stat.size;

      const rangeHeader = req.headers.range;
      let start = 0;
      let end = totalSizeBytes - 1;
      let isRange = false;

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
        if (match) {
          isRange = true;
          start = parseInt(match[1], 10);
          end = match[2] ? Math.min(parseInt(match[2], 10), totalSizeBytes - 1) : totalSizeBytes - 1;
        }
      }

      if (start >= totalSizeBytes || start > end) {
        return res.status(416).setHeader('Content-Range', `bytes */${totalSizeBytes}`).end();
      }

      const contentLength = end - start + 1;

      res.setHeader('X-Cache-Status', cacheState);
      res.setHeader('X-Storage-Proxy', 'CloudVault');
      res.setHeader('X-Storage-Tier', metadata.currentTier);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(metadata.fileName)}"`);
      res.setHeader('Content-Length', contentLength);
      if (isRange) {
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSizeBytes}`);
        res.status(206);
      } else {
        res.status(200);
      }

      fs.createReadStream(targetLocalPath, { start, end }).pipe(res);
      return;
    } catch (err) {
      if (err instanceof SecurityError) {
        return res.status(err.statusCode || 403).json({ error: err.message });
      }
      console.error('[Proxy Download Error]:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Handle Proxy Delete (DELETE)
  if (req.method === 'DELETE') {
    if (!checkRolePermission(userRole, 'delete')) {
      return res.status(403).json({ error: `Forbidden: Role '${userRole}' cannot delete files` });
    }
    try {
      const targetLocalPath = resolveTenantPath(tenantId, userRequestedPath);
      const metadata = await getFileMetadata(tenantId, userRequestedPath);

      // Delete from local disk if exists
      try {
        await fs.promises.unlink(targetLocalPath);
      } catch {}

      // Delete from MySQL
      await query('DELETE FROM files WHERE tenant_id = ? AND file_path = ?', [tenantId, userRequestedPath]);

      // Remove from Redis LRU
      const redis = getRedisClient();
      if (redis) {
        await redis.zrem('cloudvault:lru_files', `${tenantId}:${userRequestedPath}`);
      }

      return res.status(200).json({ message: 'File deleted from proxy and metadata', s3Key: metadata?.s3Key });
    } catch (err) {
      if (err instanceof SecurityError) {
        return res.status(err.statusCode || 403).json({ error: err.message });
      }
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed on proxy route' });
});

export default router;
