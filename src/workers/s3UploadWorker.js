import { Worker } from 'bullmq';
import config from '../config/index.js';
import { uploadFileToS3 } from '../services/s3Service.js';

let s3UploadWorker = null;

/**
 * Initializes and starts the BullMQ S3 Upload Worker process.
 *
 * @param {Object} [options]
 * @param {number} [options.concurrency=5] - Maximum parallel S3 uploads processed by worker
 */
export function startS3UploadWorker(options = {}) {
  if (s3UploadWorker) {
    return s3UploadWorker;
  }

  const concurrency = options.concurrency || parseInt(process.env.QUEUE_CONCURRENCY || '5', 10);

  try {
    const connection = {
      host: config.redis.host,
      port: config.redis.port,
      maxRetriesPerRequest: null,
    };

    s3UploadWorker = new Worker(
      's3-upload-queue',
      async (job) => {
        const { s3Key, targetLocalPath, bucketName } = job.data;
        console.log(`[BullMQ Worker] Processing S3 sync job ${job.id} -> ${s3Key}`);

        // Stream file from local disk cache to AWS S3
        await uploadFileToS3(s3Key, targetLocalPath, bucketName || config.s3.hotBucket);

        console.log(`[BullMQ Worker Completed] Job ${job.id} successfully synced ${s3Key} to S3.`);
        return { success: true, s3Key, completedAt: Date.now() };
      },
      {
        connection,
        concurrency,
      }
    );

    s3UploadWorker.on('completed', (job) => {
      console.log(`[BullMQ Event] Job ${job.id} finished processing.`);
    });

    s3UploadWorker.on('failed', (job, err) => {
      console.error(`[BullMQ Event Failed] Job ${job?.id} failed (Attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}`);
    });

    s3UploadWorker.on('error', (err) => {
      console.warn('[BullMQ Worker Connection Warning]:', err.message);
    });

    console.log(`⚡ [BullMQ Worker] Started S3 Background Upload Worker (Concurrency: ${concurrency})`);
  } catch (err) {
    console.warn('[BullMQ Worker Startup Error]:', err.message);
  }

  return s3UploadWorker;
}

export default {
  startS3UploadWorker,
};
