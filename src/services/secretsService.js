import awsConfig from '../config/aws.js';
import { resetS3Client } from './s3Service.js';

/**
 * Fetches a JSON secret from AWS Secrets Manager and returns its parsed value.
 * Uses the SDK's default credential chain — no hardcoded keys needed here.
 *
 * @param {string} secretName  - Secret ID or ARN in Secrets Manager
 * @param {string} [region]    - AWS region (defaults to awsConfig.region)
 * @returns {Promise<Record<string, string> | null>}
 */
export async function fetchAwsSecret(secretName, region) {
  if (!secretName) return null;

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');

    const client = new SecretsManagerClient({
      region: region || awsConfig.region,
      // No explicit credentials — uses IAM role / instance profile automatically
    });

    const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));

    if (response.SecretString) {
      const secret = JSON.parse(response.SecretString);
      console.log(`[Secrets Manager] Loaded secret '${secretName}' successfully.`);
      return secret;
    }

    if (response.SecretBinary) {
      const decoded = Buffer.from(response.SecretBinary, 'base64').toString('utf8');
      return JSON.parse(decoded);
    }
  } catch (err) {
    console.warn(`[Secrets Manager] Skipped '${secretName}':`, err.message);
  }

  return null;
}

/**
 * Applies runtime secrets from AWS Secrets Manager into awsConfig,
 * then resets the S3 client so it picks up the new credentials on next use.
 *
 * Expected secret JSON structure:
 * {
 *   "AWS_ACCESS_KEY_ID":     "...",
 *   "AWS_SECRET_ACCESS_KEY": "...",
 *   "AWS_SESSION_TOKEN":     "...",   // optional, for STS temporary credentials
 *   "S3_BUCKET_NAME":        "...",   // optional, overrides HOT_BUCKET
 *   "COLD_BUCKET":           "...",   // optional
 *   "MYSQL_PASSWORD":        "...",   // optional, returned to caller to apply
 *   "REDIS_PASSWORD":        "..."    // optional, returned to caller to apply
 * }
 *
 * @param {string} secretName
 * @param {string} [region]
 * @returns {Promise<Record<string, string> | null>} Full secret object (caller applies non-AWS fields)
 */
export async function applyAwsSecrets(secretName, region) {
  const secret = await fetchAwsSecret(secretName, region);
  if (!secret) return null;

  // Inject AWS credential overrides into the live awsConfig object
  if (secret.AWS_ACCESS_KEY_ID)     awsConfig.accessKeyId     = secret.AWS_ACCESS_KEY_ID;
  if (secret.AWS_SECRET_ACCESS_KEY) awsConfig.secretAccessKey = secret.AWS_SECRET_ACCESS_KEY;
  if (secret.AWS_SESSION_TOKEN)     awsConfig.sessionToken     = secret.AWS_SESSION_TOKEN;
  if (secret.S3_BUCKET_NAME)        awsConfig.hotBucket        = secret.S3_BUCKET_NAME;
  if (secret.COLD_BUCKET)           awsConfig.coldBucket       = secret.COLD_BUCKET;

  // Reset S3Client so next call rebuilds with the injected credentials
  resetS3Client();

  console.log('[Secrets Manager] AWS credentials and bucket config applied. S3 client reset.');
  return secret;
}

export default {
  fetchAwsSecret,
  applyAwsSecrets,
};
