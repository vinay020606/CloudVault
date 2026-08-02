import fs from 'fs';
import path from 'path';
import config from '../config/index.js';

/**
 * Updates the LRU timestamp for a file in Redis ZSET.
 *
 * @param {Object} redisClient - ioredis instance
 * @param {string} fileKey - File key identifier (e.g. tenant_101:docs/report.pdf)
 */
export async function touchFile(redisClient, fileKey) {
  if (!redisClient || !fileKey) return;
  try {
    await redisClient.zadd('cloudvault:lru_files', Date.now(), fileKey);
  } catch (err) {
    console.warn(`[LRU Warn] Failed to touch file ${fileKey}:`, err.message);
  }
}

/**
 * Calculates total size of all tenant files in local storage directory.
 *
 * @param {string} tenantsDir - Directory path
 * @returns {Promise<{totalSizeBytes: number, files: Array<{key: string, fullPath: string, size: number}>}>}
 */
export async function calculateTenantsFolderSize(tenantsDir) {
  let totalSizeBytes = 0;
  const files = [];

  async function walkDir(currentDir) {
    try {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(fullPath);
          totalSizeBytes += stat.size;
          // Compute relative key
          const relPath = path.relative(tenantsDir, fullPath).replace(/\\/g, '/');
          files.push({ key: relPath, fullPath, size: stat.size });
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  await walkDir(tenantsDir);
  return { totalSizeBytes, files };
}

/**
 * Performs eviction logic when tenant local storage size exceeds threshold.
 * Evicts oldest whole files from local disk.
 *
 * @param {Object} redisClient - ioredis client
 * @param {string} tenantsDir - Directory where tenant files reside
 * @param {number} maxCacheSizeBytes - Maximum allowable folder size in bytes
 */
export async function checkAndEvict(redisClient, tenantsDir, maxCacheSizeBytes) {
  if (!redisClient) return;

  let { totalSizeBytes } = await calculateTenantsFolderSize(tenantsDir);

  if (totalSizeBytes <= maxCacheSizeBytes) {
    return;
  }

  console.log(`[Eviction] Storage size (${totalSizeBytes} B) exceeds max limit (${maxCacheSizeBytes} B). Starting eviction...`);

  while (totalSizeBytes > maxCacheSizeBytes) {
    // Fetch oldest file key from Redis LRU ZSET
    const oldest = await redisClient.zrange('cloudvault:lru_files', 0, 0);
    if (!oldest || oldest.length === 0) {
      console.log('[Eviction] No more files in LRU set to process.');
      break;
    }

    const fileKey = oldest[0]; // e.g. tenant_101:documents/report.pdf
    const parts = fileKey.split(':');
    const tenantId = parts[0];
    const userPath = parts.slice(1).join(':');

    const filePath = path.join(tenantsDir, tenantId, userPath);

    let fileSize = 0;
    try {
      const stat = await fs.promises.stat(filePath);
      fileSize = stat.size;
    } catch {
      // File already removed from disk
    }

    try {
      await fs.promises.unlink(filePath);
      console.log(`[Eviction] Deleted LRU file from local cache disk: ${fileKey}`);
    } catch (unlinkErr) {
      if (unlinkErr.code !== 'ENOENT') {
        console.error(`[Eviction] Error deleting file ${filePath}:`, unlinkErr.message);
      }
    }

    // Remove key from Redis ZSET
    await redisClient.zrem('cloudvault:lru_files', fileKey);
    totalSizeBytes -= fileSize;
  }
}

/**
 * Starts a background interval worker for cache size eviction monitoring.
 *
 * @param {Object} redisClient - ioredis client
 * @param {Object} [options] - Options object
 * @returns {NodeJS.Timeout} Timer handle
 */
export function startEvictionWatcher(redisClient, options = {}) {
  const tenantsDir = options.tenantsDir || config.storage.tenantsDir;
  const maxCacheSizeBytes = options.maxCacheSizeBytes || config.storage.maxCacheSizeBytes;
  const intervalMs = options.intervalMs || 10000;

  console.log(`[Eviction Watcher] Started with max cache size: ${maxCacheSizeBytes} B, interval: ${intervalMs} ms.`);

  const timer = setInterval(() => {
    checkAndEvict(redisClient, tenantsDir, maxCacheSizeBytes).catch((err) => {
      console.error('[Eviction Watcher Error]:', err);
    });
  }, intervalMs);

  return timer;
}

/**
 * Invalidates and removes a file from local disk cache and Redis LRU tracking
 * when the file is updated or changed in S3.
 *
 * @param {string} tenantId - Tenant ID
 * @param {string} filePath - User file path
 * @returns {Promise<boolean>} True if local cache file was removed, false otherwise
 */
export async function invalidateFileCache(tenantId, filePath) {
  if (!tenantId || !filePath) return false;
  const fileKey = `${tenantId}:${filePath}`;
  let removed = false;

  try {
    const tenantsDir = config.storage.tenantsDir;
    const localDiskPath = path.join(tenantsDir, tenantId, filePath.replace(/^(\/|\\)+/, ''));
    await fs.promises.unlink(localDiskPath);
    removed = true;
    console.log(`[Cache Invalidation] Successfully purged local disk cache for updated S3 object: ${fileKey}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[Cache Invalidation Warn] Error unlinking ${filePath}:`, err.message);
    }
  }

  return removed;
}

export default {
  touchFile,
  calculateTenantsFolderSize,
  checkAndEvict,
  startEvictionWatcher,
  invalidateFileCache,
};
