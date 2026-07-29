import express from 'express';
import { getPool } from '../db/mysql.js';
import { getRedisClient } from '../db/redis.js';
import { calculateTenantsFolderSize } from '../services/evictionService.js';
import config from '../config/index.js';

const router = express.Router();

/**
 * GET /health
 * Basic health check endpoint
 */
router.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'CloudVault Gateway',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/metrics
 * Comprehensive system infrastructure health and storage metrics
 */
router.get('/metrics', async (req, res) => {
  const metrics = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      mysql: { status: 'unknown' },
      redis: { status: 'unknown' },
    },
    storage: {
      tenantsDir: config.storage.tenantsDir,
      maxCacheSizeBytes: config.storage.maxCacheSizeBytes,
      usedSizeBytes: 0,
      cachedFilesCount: 0,
    },
  };

  // Check MySQL
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    metrics.services.mysql = { status: 'connected', poolLimit: 10 };
  } catch (err) {
    metrics.services.mysql = { status: 'disconnected', error: err.message };
    metrics.status = 'degraded';
  }

  // Check Redis
  try {
    const redis = getRedisClient();
    const pingRes = await redis.ping();
    metrics.services.redis = { status: pingRes === 'PONG' ? 'connected' : 'error' };
  } catch (err) {
    metrics.services.redis = { status: 'disconnected', error: err.message };
    metrics.status = 'degraded';
  }

  // Measure Disk Storage Usage
  try {
    const storageMetrics = await calculateTenantsFolderSize(config.storage.tenantsDir);
    metrics.storage.usedSizeBytes = storageMetrics.totalSizeBytes;
    metrics.storage.cachedFilesCount = storageMetrics.files.length;
  } catch (err) {
    metrics.storage.error = err.message;
  }

  return res.json(metrics);
});

export default router;
