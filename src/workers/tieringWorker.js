import { query } from '../db/mysql.js';
import config from '../config/index.js';
import { copyObjectBetweenBuckets, deleteObjectFromBucket } from '../services/s3Service.js';

/**
 * Intelligent Storage Tiering Background Worker
 * Migrates stale, unaccessed files from S3 Hot Bucket (Standard) to S3 Cold Bucket (Glacier).
 *
 * @param {number} [inactivityDays] - Number of days of inactivity before tiering to Cold storage
 * @returns {Promise<Object>} Migration report summary
 */
export async function runIntelligentTiering(inactivityDays) {
  const days = inactivityDays || config.tiering.inactivityDays || 30;
  console.log(`[Tiering Worker] Running Intelligent Tiering scan for files unaccessed in ${days} days...`);

  const hotBucket = config.s3.hotBucket;
  const coldBucket = config.s3.coldBucket;

  const sql = `
    SELECT id, tenant_id, file_path, file_name, s3_key, current_tier, last_accessed_at
    FROM files
    WHERE current_tier = 'HOT'
    AND last_accessed_at < NOW() - INTERVAL ? DAY
  `;

  let staleFiles = [];
  try {
    staleFiles = await query(sql, [days]);
  } catch (err) {
    console.error('[Tiering Worker Error] Failed querying stale files:', err.message);
    return { status: 'error', error: err.message };
  }

  if (!staleFiles || staleFiles.length === 0) {
    console.log('[Tiering Worker] No stale files found requiring migration.');
    return { status: 'success', migratedCount: 0, files: [] };
  }

  console.log(`[Tiering Worker] Found ${staleFiles.length} stale file(s) to migrate to Cold storage.`);
  const migratedFiles = [];
  const errors = [];

  for (const file of staleFiles) {
    try {
      // 1. Copy object from Hot Bucket to Cold Glacier Bucket
      await copyObjectBetweenBuckets(hotBucket, coldBucket, file.s3_key, 'GLACIER');

      // 2. Delete object from Hot Bucket
      await deleteObjectFromBucket(hotBucket, file.s3_key);

      // 3. Update metadata in MySQL
      await query(`UPDATE files SET current_tier = 'COLD' WHERE id = ?`, [file.id]);

      console.log(`[Tiering Worker] Successfully migrated file ID ${file.id} (${file.s3_key}) -> COLD tier.`);
      migratedFiles.push(file.s3_key);
    } catch (err) {
      console.error(`[Tiering Worker] Failed to tier file ID ${file.id} (${file.s3_key}):`, err.message);
      errors.push({ id: file.id, s3Key: file.s3_key, error: err.message });
    }
  }

  return {
    status: 'success',
    migratedCount: migratedFiles.length,
    migratedFiles,
    errors,
  };
}

/**
 * Starts a background scheduled worker running Intelligent Tiering scans.
 *
 * @param {number} [intervalMs=86400000] - Interval in milliseconds (default: 24 hours)
 * @returns {NodeJS.Timeout} Timer handle
 */
export function startTieringCron(intervalMs = 86400000) {
  console.log(`[Tiering Cron] Scheduled nightly background worker running every ${intervalMs} ms.`);
  const timer = setInterval(() => {
    runIntelligentTiering().catch((err) => {
      console.error('[Tiering Cron Error]:', err.message);
    });
  }, intervalMs);
  return timer;
}

export default {
  runIntelligentTiering,
  startTieringCron,
};
