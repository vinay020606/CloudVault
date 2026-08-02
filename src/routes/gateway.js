import express from 'express';
import busboy from 'busboy';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import config from '../config/index.js';
import { resolveTenantPath, SecurityError } from '../utils/pathSanitizer.js';
import { createFileRecord, getFileMetadata, touchFileAccess, listTenantFiles, deleteFileRecord } from '../services/metadataService.js';
import { execute as singleflightExecute } from '../services/singleflightService.js';
import { touchFile, invalidateFileCache } from '../services/evictionService.js';
import { uploadFileToS3, downloadFileFromS3, restoreGlacierObject } from '../services/s3Service.js';
import { getRedisClient } from '../db/redis.js';

const router = express.Router();

/**
 * POST /api/v1/gateway/upload
 * Headers: x-tenant-id
 * Form-Data / Stream: filePath, file
 */
router.post('/upload', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) {
    return res.status(400).json({ error: 'Missing x-tenant-id header' });
  }

  const contentType = req.headers['content-type'] || '';

  if (!contentType.includes('multipart/form-data')) {
    try {
      const userRequestedPath = req.query.filePath || req.headers['x-file-path'] || 'uploaded_file.bin';
      const fileName = path.basename(userRequestedPath);

      // 1. Path sanitization
      const targetLocalPath = resolveTenantPath(tenantId, userRequestedPath);
      await fs.promises.mkdir(path.dirname(targetLocalPath), { recursive: true });

      // 2. Stream raw body directly to local tenant storage file
      await pipeline(req, fs.createWriteStream(targetLocalPath));
      const stat = await fs.promises.stat(targetLocalPath);
      const totalSizeBytes = stat.size;

      const normalizedRelPath = userRequestedPath.replace(/^(\/|\\)+/, '');
      const s3Key = `tenants/${tenantId}/${normalizedRelPath}`;

      // 3. Write MySQL Metadata
      const fileRecord = await createFileRecord(
        tenantId,
        userRequestedPath,
        fileName,
        totalSizeBytes,
        s3Key
      );

      // 4. Queue background upload to S3 Hot Bucket
      uploadFileToS3(s3Key, targetLocalPath, config.s3.hotBucket).catch((err) => {
        console.warn(`[Background S3 Upload Failed] ${s3Key}:`, err.message);
      });

      // 5. Update Redis LRU
      const redis = getRedisClient();
      touchFile(redis, `${tenantId}:${userRequestedPath}`).catch(() => {});

      return res.status(201).json({
        message: 'File uploaded successfully',
        file: fileRecord,
      });
    } catch (err) {
      if (err instanceof SecurityError) {
        return res.status(err.statusCode || 403).json({ error: err.message });
      }
      console.error('[Upload Error]:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // Handle multipart/form-data using busboy
  try {
    const bb = busboy({ headers: req.headers });
    let targetFilePath = req.query.filePath || '';
    let originalFileName = 'file.bin';
    let fileProcessingPromise = null;
    let uploadError = null;

    bb.on('field', (fieldname, val) => {
      if (fieldname === 'filePath') {
        targetFilePath = val;
      }
    });

    bb.on('file', (fieldname, fileStream, info) => {
      const { filename } = info;
      if (!targetFilePath) {
        targetFilePath = filename;
      }
      originalFileName = filename || path.basename(targetFilePath);

      fileProcessingPromise = (async () => {
        // 1. Sanitize Path & Target File
        const targetLocalPath = resolveTenantPath(tenantId, targetFilePath);
        await fs.promises.mkdir(path.dirname(targetLocalPath), { recursive: true });

        // 2. Stream file to local disk
        await pipeline(fileStream, fs.createWriteStream(targetLocalPath));
        const stat = await fs.promises.stat(targetLocalPath);
        return { targetLocalPath, sizeBytes: stat.size };
      })();
    });

    bb.on('error', (err) => {
      uploadError = err;
    });

    bb.on('finish', async () => {
      if (uploadError) {
        return res.status(500).json({ error: uploadError.message });
      }

      if (!fileProcessingPromise) {
        return res.status(400).json({ error: 'No file found in request body' });
      }

      try {
        const { targetLocalPath, sizeBytes } = await fileProcessingPromise;
        const normalizedRelPath = targetFilePath.replace(/^(\/|\\)+/, '');
        const s3Key = `tenants/${tenantId}/${normalizedRelPath}`;

        // 3. Write MySQL Metadata
        const fileRecord = await createFileRecord(
          tenantId,
          targetFilePath,
          originalFileName,
          sizeBytes,
          s3Key
        );

        // 4. Queue background pipe to S3 Hot Bucket
        uploadFileToS3(s3Key, targetLocalPath, config.s3.hotBucket).catch((err) => {
          console.warn(`[Background S3 Sync Error] ${s3Key}:`, err.message);
        });

        // 5. Update Redis LRU
        const redis = getRedisClient();
        touchFile(redis, `${tenantId}:${targetFilePath}`).catch(() => {});

        return res.status(201).json({
          message: 'File uploaded successfully',
          file: fileRecord,
        });
      } catch (err) {
        if (err instanceof SecurityError) {
          return res.status(err.statusCode || 403).json({ error: err.message });
        }
        console.error('[Upload Process Error]:', err);
        return res.status(500).json({ error: err.message });
      }
    });

    req.pipe(bb);
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 403).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/gateway/download
 * Headers: x-tenant-id
 * Query: filePath
 */
router.get('/download', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  const userRequestedPath = req.query.filePath;

  if (!tenantId) {
    return res.status(400).json({ error: 'Missing x-tenant-id header' });
  }

  if (!userRequestedPath) {
    return res.status(400).json({ error: 'Missing filePath query parameter' });
  }

  try {
    // 1. Path Sanitization Check
    const targetLocalPath = resolveTenantPath(tenantId, userRequestedPath);

    // 2. Query MySQL Metadata
    const metadata = await getFileMetadata(tenantId, userRequestedPath);
    if (!metadata) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Touch access metrics
    touchFileAccess(tenantId, userRequestedPath).catch(() => {});

    const redis = getRedisClient();
    const fileKey = `${tenantId}:${userRequestedPath}`;
    let fileBuffer = null;

    // Check local disk file
    let localExists = false;
    try {
      await fs.promises.access(targetLocalPath);
      localExists = true;
    } catch {
      localExists = false;
    }

    if (localExists) {
      // Cache Hit! Serve immediately regardless of cloud tier (~3.8ms)
      fileBuffer = await fs.promises.readFile(targetLocalPath);
      touchFile(redis, fileKey).catch(() => {});
    } else {
      // Cache Miss: Check Storage Tier (HOT vs COLD)
      if (metadata.currentTier === 'COLD') {
        // Trigger Glacier Restore Job
        restoreGlacierObject(metadata.s3Key, config.s3.coldBucket).catch(() => {});
        return res.status(202).json({
          status: 'archived',
          message: 'File is being restored from Glacier cold storage. Available in local cache within 3-5 hours.',
          s3Key: metadata.s3Key,
        });
      }

      // Cache Miss & Tier == 'HOT': Fetch from S3 Hot Bucket
      console.log(`[Cache Miss] File ${fileKey} missing locally. Fetching via Singleflight from S3 Hot Bucket...`);
      fileBuffer = await singleflightExecute(fileKey, async () => {
        const s3Data = await downloadFileFromS3(metadata.s3Key, config.s3.hotBucket);
        await fs.promises.mkdir(path.dirname(targetLocalPath), { recursive: true });
        await fs.promises.writeFile(targetLocalPath, s3Data);
        touchFile(redis, fileKey).catch(() => {});
        return s3Data;
      });
    }

    const totalSizeBytes = fileBuffer.length;

    // Support HTTP 200 / HTTP 206 Range headers
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = totalSizeBytes - 1;
    let isRange = false;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
      if (match) {
        isRange = true;
        start = parseInt(match[1], 10);
        if (match[2]) {
          end = parseInt(match[2], 10);
        }
      }
    }

    if (start >= totalSizeBytes || end >= totalSizeBytes || start > end) {
      return res.status(416).setHeader('Content-Range', `bytes */${totalSizeBytes}`).end();
    }

    const contentLength = end - start + 1;

    if (isRange) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSizeBytes}`);
    } else {
      res.status(200);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(metadata.fileName)}"`);
    res.setHeader('Content-Length', contentLength);

    return res.end(fileBuffer.subarray(start, end + 1));
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 403).json({ error: err.message });
    }
    console.error('[Download Error]:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
    res.end();
  }
});

/**
 * GET /api/v1/gateway/files
 * Headers: x-tenant-id
 * Returns array of tenant files
 */
router.get('/files', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) {
    return res.status(400).json({ error: 'Missing x-tenant-id header' });
  }

  try {
    const files = await listTenantFiles(tenantId);
    return res.json({ files });
  } catch (err) {
    console.error('[List Files Error]:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/v1/gateway/files
 * Headers: x-tenant-id
 * Query: filePath
 */
router.delete('/files', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  const filePath = req.query.filePath;

  if (!tenantId) {
    return res.status(400).json({ error: 'Missing x-tenant-id header' });
  }

  if (!filePath) {
    return res.status(400).json({ error: 'Missing filePath query parameter' });
  }

  try {
    const targetLocalPath = resolveTenantPath(tenantId, filePath);
    try {
      await fs.promises.unlink(targetLocalPath);
    } catch {}

    await deleteFileRecord(tenantId, filePath);

    const redis = getRedisClient();
    if (redis) {
      await redis.zrem('cloudvault:lru_files', `${tenantId}:${filePath}`).catch(() => {});
    }

    return res.json({ message: 'File deleted successfully', filePath });
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 403).json({ error: err.message });
    }
    console.error('[Delete Error]:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/gateway/invalidate
 * Headers: x-tenant-id (or body.tenantId)
 * Query/Body: filePath
 * Triggered whenever a file is changed/updated in S3 to purge the local disk cache
 */
router.post('/invalidate', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || req.body?.tenantId;
  const filePath = req.query.filePath || req.body?.filePath;

  if (!tenantId || !filePath) {
    return res.status(400).json({ error: 'Missing tenantId or filePath parameters' });
  }

  try {
    const purged = await invalidateFileCache(tenantId, filePath);
    return res.json({
      invalidated: true,
      purgedLocalDisk: purged,
      tenantId,
      filePath,
      message: `Local cache for ${filePath} invalidated successfully. Next download will fetch latest S3 version.`,
    });
  } catch (err) {
    console.error('[Invalidate Error]:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
