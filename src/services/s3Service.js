import {
  S3Client,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  RestoreObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import config from '../config/index.js';

let s3Client = null;

export function getS3Client() {
  if (!s3Client) {
    const s3Options = {
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
    };
    if (config.s3.endpoint) {
      s3Options.endpoint = config.s3.endpoint;
      s3Options.forcePathStyle = true;
    }
    s3Client = new S3Client(s3Options);
  }
  return s3Client;
}

/**
 * Resolves the S3 bucket name for a tenant and tier.
 * Supports both shared tenant prefix buckets and dynamic per-tenant buckets.
 *
 * @param {string} [tenantId] - Optional tenant ID
 * @param {string} [tier='HOT'] - Storage tier ('HOT' or 'COLD')
 * @returns {string} Bucket name
 */
export function getTenantBucket(tenantId, tier = 'HOT') {
  const baseBucket = tier === 'COLD' ? config.s3.coldBucket : config.s3.hotBucket;

  if (tenantId && process.env.DYNAMIC_TENANT_BUCKETS === 'true') {
    const sanitizedTenant = tenantId.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return `${baseBucket}-${sanitizedTenant}`;
  }

  return baseBucket;
}

/**
 * Uploads a file to an S3 bucket via streaming transmission.
 *
 * @param {string} s3Key - S3 Object Key
 * @param {string|Buffer|Readable} source - Source data
 * @param {string} [bucketName] - Target S3 bucket name
 */
export async function uploadFileToS3(s3Key, source, bucketName = config.s3.hotBucket) {
  const client = getS3Client();

  let body = source;
  if (typeof source === 'string') {
    body = fs.createReadStream(source);
  }

  try {
    const parallelUpload = new Upload({
      client,
      params: {
        Bucket: bucketName,
        Key: s3Key,
        Body: body,
      },
    });
    await parallelUpload.done();
    console.log(`[S3 Transmission] Successfully streamed file to S3 (${bucketName}): ${s3Key}`);
  } catch (err) {
    console.warn(`[S3 Transmission Warn] Failed uploading file ${s3Key} to S3 (${bucketName}):`, err.message);
  }
}

/**
 * Downloads a file from an S3 bucket as a Buffer.
 *
 * @param {string} s3Key - S3 Object Key
 * @param {string} [bucketName] - Target S3 bucket name
 * @returns {Promise<Buffer>}
 */
export async function downloadFileFromS3(s3Key, bucketName = config.s3.hotBucket) {
  const client = getS3Client();

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
  });

  const response = await client.send(command);
  const byteArray = await response.Body.transformToByteArray();
  return Buffer.from(byteArray);
}

/**
 * Copies an object between S3 buckets with storage class setting (e.g. GLACIER).
 *
 * @param {string} sourceBucket - Source S3 Bucket
 * @param {string} destBucket - Destination S3 Bucket
 * @param {string} s3Key - S3 Object Key
 * @param {string} [storageClass='GLACIER'] - S3 Storage Class
 */
export async function copyObjectBetweenBuckets(sourceBucket, destBucket, s3Key, storageClass = 'GLACIER') {
  const client = getS3Client();

  const command = new CopyObjectCommand({
    CopySource: `${sourceBucket}/${s3Key}`,
    Bucket: destBucket,
    Key: s3Key,
    StorageClass: storageClass,
  });

  await client.send(command);
  console.log(`[S3 Tiering Copy] Copied ${s3Key} from ${sourceBucket} -> ${destBucket} (StorageClass: ${storageClass})`);
}

/**
 * Deletes an object from an S3 bucket.
 *
 * @param {string} bucketName - Target S3 Bucket
 * @param {string} s3Key - S3 Object Key
 */
export async function deleteObjectFromBucket(bucketName, s3Key) {
  const client = getS3Client();

  const command = new DeleteObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
  });

  await client.send(command);
  console.log(`[S3 Delete] Deleted ${s3Key} from bucket ${bucketName}`);
}

/**
 * Sends a RestoreObjectCommand to initiate retrieval from Glacier/Deep Archive cold storage.
 *
 * @param {string} s3Key - S3 Object Key
 * @param {string} [bucketName=config.s3.coldBucket] - Cold S3 Bucket Name
 */
export async function restoreGlacierObject(s3Key, bucketName = config.s3.coldBucket) {
  const client = getS3Client();

  try {
    const command = new RestoreObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      RestoreRequest: {
        Days: 7,
        GlacierJobParameters: {
          Tier: 'Standard',
        },
      },
    });
    await client.send(command);
    console.log(`[S3 Restore] Triggered restore job for cold file ${s3Key} in bucket ${bucketName}`);
  } catch (err) {
    console.warn(`[S3 Restore Info] ${s3Key} restore status:`, err.message);
  }
}

export default {
  getS3Client,
  getTenantBucket,
  uploadFileToS3,
  downloadFileFromS3,
  copyObjectBetweenBuckets,
  deleteObjectFromBucket,
  restoreGlacierObject,
};
