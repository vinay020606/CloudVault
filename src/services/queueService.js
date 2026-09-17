import { Queue } from 'bullmq';
import config from '../config/index.js';

let s3UploadQueue = null;

/**
 * Returns or initializes the BullMQ Queue instance for background S3 uploads.
 */
export function getS3UploadQueue() {
  if (!s3UploadQueue) {
    try {
      const connection = {
        host: config.redis.host,
        port: config.redis.port,
        maxRetriesPerRequest: null,
      };

      s3UploadQueue = new Queue('s3-upload-queue', {
        connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
          removeOnComplete: 100, // Keep last 100 completed jobs for audit
          removeOnFail: 500,     // Keep last 500 failed jobs for debugging
        },
      });

      s3UploadQueue.on('error', (err) => {
        console.warn('[BullMQ Queue Warning]:', err.message);
      });
    } catch (err) {
      console.warn('[BullMQ Queue Init Error]:', err.message);
    }
  }
  return s3UploadQueue;
}

/**
 * Adds an S3 upload task to the BullMQ job queue.
 *
 * @param {Object} payload
 * @param {string} payload.tenantId - Tenant identifier
 * @param {string} payload.filePath - File path requested by user
 * @param {string} payload.targetLocalPath - Absolute local disk file path
 * @param {string} payload.s3Key - Target S3 Key
 * @param {string} [payload.bucketName] - Target S3 Bucket name
 * @returns {Promise<Object>} Job details or status
 */
export async function addS3UploadJob(payload) {
  const { tenantId, filePath, targetLocalPath, s3Key, bucketName = config.s3.hotBucket } = payload;
  const jobId = `s3-upload-${tenantId}-${filePath.replace(/[/\\?%*:|"<>]/g, '_')}`;

  const queue = getS3UploadQueue();

  if (queue) {
    try {
      const job = await queue.add(
        'uploadFileToS3',
        {
          tenantId,
          filePath,
          targetLocalPath,
          s3Key,
          bucketName,
          queuedAt: Date.now(),
        },
        { jobId }
      );
      console.log(`[BullMQ Enqueued] Job ${job.id} enqueued for S3 sync: ${s3Key}`);
      return { status: 'QUEUED', jobId: job.id };
    } catch (err) {
      console.warn(`[BullMQ Enqueue Failed for ${s3Key}]: ${err.message}. Falling back to inline async execution.`);
    }
  }

  // Graceful Fallback if BullMQ/Redis queue is not available
  return { status: 'FALLBACK_INLINE', s3Key };
}

export default {
  getS3UploadQueue,
  addS3UploadJob,
};
