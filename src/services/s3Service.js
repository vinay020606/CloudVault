import {
  S3Client,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  RestoreObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import awsConfig, { resolveCredentials } from '../config/aws.js';

let s3Client = null;

/**
 * Returns (or lazily initialises) the shared S3Client.
 * Credentials come from resolveCredentials():
 *   - explicit keys from env  →  passed directly
 *   - no keys set             →  SDK falls back to IAM role / instance profile automatically
 * Call resetS3Client() after fetchAwsSecret() updates awsConfig at runtime.
 */
export function getS3Client() {
  if (!s3Client) {
    const options = {
      region: awsConfig.region,
    };

    const credentials = resolveCredentials();
    if (credentials) {
      options.credentials = credentials;
    }
    // If credentials is undefined the SDK uses its default credential provider chain:
    //   env vars → ~/.aws/credentials → EC2 instance profile → ECS task role → Lambda role

    if (awsConfig.endpoint) {
      options.endpoint      = awsConfig.endpoint;
      options.forcePathStyle = awsConfig.forcePathStyle;
    }

    s3Client = new S3Client(options);
  }
  return s3Client;
}

/**
 * Resets the cached S3Client so the next call to getS3Client() rebuilds it.
 * Call this after AWS Secrets Manager injects new credentials at runtime.
 */
export function resetS3Client() {
  s3Client = null;
}

/**
 * Resolves the S3 bucket name for a given tenant and storage tier.
 * Set DYNAMIC_TENANT_BUCKETS=true to enable per-tenant bucket routing.
 *
 * @param {string} [tenantId]
 * @param {'HOT'|'COLD'} [tier='HOT']
 * @returns {string}
 */
export function getTenantBucket(tenantId, tier = 'HOT') {
  const baseBucket = tier === 'COLD' ? awsConfig.coldBucket : awsConfig.hotBucket;

  if (!baseBucket) {
    throw new Error(
      `S3 bucket not configured for tier '${tier}'. ` +
      `Set ${tier === 'COLD' ? 'COLD_BUCKET' : 'HOT_BUCKET or S3_BUCKET_NAME'} in your environment.`
    );
  }

  if (tenantId && process.env.DYNAMIC_TENANT_BUCKETS === 'true') {
    const sanitizedTenant = tenantId.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return `${baseBucket}-${sanitizedTenant}`;
  }

  return baseBucket;
}

/**
 * Uploads a file to S3 via multipart streaming (no full-file buffering).
 *
 * @param {string} s3Key
 * @param {string|import('stream').Readable} source - File path string or readable stream
 * @param {string} [bucketName]
 */
export async function uploadFileToS3(s3Key, source, bucketName) {
  const bucket = bucketName || getTenantBucket(undefined, 'HOT');
  const client = getS3Client();

  const body = typeof source === 'string' ? fs.createReadStream(source) : source;

  try {
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key:    s3Key,
        Body:   body,
      },
      queueSize:   4,  // parallel part uploads
      partSize:    5 * 1024 * 1024, // 5 MB parts (S3 minimum)
      leavePartsOnError: false,
    });

    await upload.done();
    console.log(`[S3] Uploaded → s3://${bucket}/${s3Key}`);
  } catch (err) {
    console.warn(`[S3] Upload failed for ${s3Key}:`, err.message);
    throw err;
  }
}

/**
 * Downloads an S3 object and returns its content as a Buffer.
 *
 * @param {string} s3Key
 * @param {string} [bucketName]
 * @returns {Promise<Buffer>}
 */
export async function downloadFileFromS3(s3Key, bucketName) {
  const bucket = bucketName || getTenantBucket(undefined, 'HOT');
  const client = getS3Client();

  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
  const byteArray = await response.Body.transformToByteArray();
  return Buffer.from(byteArray);
}

/**
 * Checks whether an S3 object exists without downloading it.
 *
 * @param {string} s3Key
 * @param {string} [bucketName]
 * @returns {Promise<boolean>}
 */
export async function objectExists(s3Key, bucketName) {
  const bucket = bucketName || getTenantBucket(undefined, 'HOT');
  const client = getS3Client();

  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

/**
 * Copies an S3 object to another bucket (used for Hot → Cold Glacier tiering).
 *
 * @param {string} sourceBucket
 * @param {string} destBucket
 * @param {string} s3Key
 * @param {string} [storageClass='GLACIER']
 */
export async function copyObjectBetweenBuckets(sourceBucket, destBucket, s3Key, storageClass = 'GLACIER') {
  const client = getS3Client();

  await client.send(new CopyObjectCommand({
    CopySource:    `${sourceBucket}/${s3Key}`,
    Bucket:        destBucket,
    Key:           s3Key,
    StorageClass:  storageClass,
  }));

  console.log(`[S3] Tiering copy: s3://${sourceBucket}/${s3Key} → s3://${destBucket}/${s3Key} (${storageClass})`);
}

/**
 * Deletes an S3 object from the given bucket.
 *
 * @param {string} bucketName
 * @param {string} s3Key
 */
export async function deleteObjectFromBucket(bucketName, s3Key) {
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: s3Key }));
  console.log(`[S3] Deleted s3://${bucketName}/${s3Key}`);
}

/**
 * Initiates a Glacier restore job for a cold-tier object.
 * The object becomes temporarily available after 3–5 hours (Standard tier).
 *
 * @param {string} s3Key
 * @param {string} [bucketName]
 * @param {number} [restoreDays=7] - How many days to keep the restored copy available
 */
export async function restoreGlacierObject(s3Key, bucketName, restoreDays = 7) {
  const bucket = bucketName || getTenantBucket(undefined, 'COLD');
  const client = getS3Client();

  try {
    await client.send(new RestoreObjectCommand({
      Bucket: bucket,
      Key:    s3Key,
      RestoreRequest: {
        Days: restoreDays,
        GlacierJobParameters: { Tier: 'Standard' }, // Standard = 3–5h, Expedited = 1–5min (costs more)
      },
    }));
    console.log(`[S3] Glacier restore initiated for s3://${bucket}/${s3Key} (available in ~3–5h)`);
  } catch (err) {
    // RestoreAlreadyInProgress is not an error — object is already being restored
    if (err.name === 'RestoreAlreadyInProgress') {
      console.log(`[S3] Glacier restore already in progress for ${s3Key}`);
    } else {
      console.warn(`[S3] Glacier restore warning for ${s3Key}:`, err.message);
    }
  }
}

export default {
  getS3Client,
  resetS3Client,
  getTenantBucket,
  uploadFileToS3,
  downloadFileFromS3,
  objectExists,
  copyObjectBetweenBuckets,
  deleteObjectFromBucket,
  restoreGlacierObject,
};
