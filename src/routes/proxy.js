import express from 'express';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import config from '../config/index.js';
import { resolveTenantPath, SecurityError } from '../utils/pathSanitizer.js';
import { createFileRecord, getFileMetadata } from '../services/metadataService.js';
import { execute as singleflightExecute } from '../services/singleflightService.js';
import { touchFile } from '../services/evictionService.js';
import { uploadFileToS3, downloadFileFromS3 } from '../services/s3Service.js';
import { getRedisClient } from '../db/redis.js';
import { query } from '../db/mysql.js';

const router = express.Router();

/**
 * Transparent Storage Proxy Route
 * PUT/POST /proxy/:tenantId/* - Proxy Upload
 */
router.all('/:tenantId/*', async (req, res) => {
  const tenantId = req.params.tenantId;
  const userRequestedPath = req.params[0];

  if (!tenantId) {
    return res.status(400).json({ error: 'Missing tenant ID in URL path' });
  }

  if (!userRequestedPath) {
    return res.status(400).json({ error: 'Missing file path in URL' });
  }

  // Handle Proxy Upload (PUT or POST)
  if (req.method === 'PUT' || req.method === 'POST') {
    try {
      const fileName = path.basename(userRequestedPath);

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

      // 4. Background Proxy Pipe to S3
      uploadFileToS3(s3Key, targetLocalPath).catch((err) => {
        console.warn(`[Proxy Background S3 Upload Failed] ${s3Key}:`, err.message);
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
    try {
      // 1. Path Sanitization Check
      const targetLocalPath = resolveTenantPath(tenantId, userRequestedPath);

      // 2. Query MySQL Metadata
      const metadata = await getFileMetadata(tenantId, userRequestedPath);
      if (!metadata) {
        return res.status(404).json({ error: 'File not found in storage proxy' });
      }

      const redis = getRedisClient();
      const fileKey = `${tenantId}:${userRequestedPath}`;
      let fileBuffer = null;
      let cacheState = 'CACHE_HIT';

      // Check local disk file
      let localExists = false;
      try {
        await fs.promises.access(targetLocalPath);
        localExists = true;
      } catch {
        localExists = false;
      }

      if (localExists) {
        // Cache Hit!
        fileBuffer = await fs.promises.readFile(targetLocalPath);
        touchFile(redis, fileKey).catch(() => {});
      } else {
        // Cache Miss! Fetch via Singleflight Service from S3
        cacheState = 'CACHE_MISS_S3_FETCH';
        console.log(`[Proxy Cache Miss] ${fileKey} missing locally. Fetching via Singleflight S3 Proxy...`);
        fileBuffer = await singleflightExecute(fileKey, async () => {
          const s3Data = await downloadFileFromS3(metadata.s3Key);
          await fs.promises.mkdir(path.dirname(targetLocalPath), { recursive: true });
          await fs.promises.writeFile(targetLocalPath, s3Data);
          touchFile(redis, fileKey).catch(() => {});
          return s3Data;
        });
      }

      const totalSizeBytes = fileBuffer.length;

      res.setHeader('X-Cache-Status', cacheState);
      res.setHeader('X-Storage-Proxy', 'CloudVault');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(metadata.fileName)}"`);
      res.setHeader('Content-Length', totalSizeBytes);

      return res.status(200).send(fileBuffer);
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
