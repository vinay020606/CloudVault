import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
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
 * Uploads a tenant file to S3 in the background.
 *
 * @param {string} s3Key - Destination key in S3 (e.g. tenants/tenant_101/docs/report.pdf)
 * @param {string|Buffer|Readable} source - Source file path, buffer, or stream
 * @returns {Promise<void>}
 */
export async function uploadFileToS3(s3Key, source) {
  const client = getS3Client();

  let body = source;
  if (typeof source === 'string') {
    body = fs.createReadStream(source);
  }

  try {
    const parallelUpload = new Upload({
      client,
      params: {
        Bucket: config.s3.bucketName,
        Key: s3Key,
        Body: body,
      },
    });
    await parallelUpload.done();
    console.log(`[S3 Upload] Successfully synced file to S3: ${s3Key}`);
  } catch (err) {
    console.warn(`[S3 Upload Warn] Failed uploading file ${s3Key} to S3:`, err.message);
  }
}

/**
 * Downloads a whole file from S3 as a Buffer.
 *
 * @param {string} s3Key - S3 object key
 * @returns {Promise<Buffer>} File buffer
 */
export async function downloadFileFromS3(s3Key) {
  const client = getS3Client();

  const command = new GetObjectCommand({
    Bucket: config.s3.bucketName,
    Key: s3Key,
  });

  const response = await client.send(command);
  const byteArray = await response.Body.transformToByteArray();
  return Buffer.from(byteArray);
}

export default {
  getS3Client,
  uploadFileToS3,
  downloadFileFromS3,
};
