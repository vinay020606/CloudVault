import dotenv from 'dotenv';
dotenv.config();

/**
 * AWS configuration skeleton.
 * Credentials are resolved in this priority order:
 *   1. AWS Secrets Manager  (set SECRETS_MANAGER_NAME or AWS_SECRET_NAME)
 *   2. Environment variables (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
 *   3. IAM Instance / Task Role  (automatic when running on EC2 / ECS — no config needed)
 *
 * Do NOT hardcode credentials here.
 * Fill in your values via .env or AWS Secrets Manager.
 */

export const awsConfig = {
  // ─── Region ────────────────────────────────────────────────────────────────
  region: process.env.AWS_REGION || 'us-east-1',

  // ─── Credentials (leave blank to use IAM role) ─────────────────────────────
  // When running on EC2/ECS/Lambda with an attached IAM role,
  // do NOT set these — the SDK picks them up automatically.
  accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || null,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || null,
  sessionToken:    process.env.AWS_SESSION_TOKEN     || null, // for temporary STS credentials

  // ─── S3 Buckets ────────────────────────────────────────────────────────────
  hotBucket:  process.env.HOT_BUCKET  || process.env.S3_BUCKET_NAME || null,
  coldBucket: process.env.COLD_BUCKET || null,

  // ─── Optional: LocalStack / MinIO endpoint for local development ───────────
  // Set S3_ENDPOINT=http://localhost:4566 and the SDK will use that instead of real AWS.
  endpoint:       process.env.S3_ENDPOINT   || null,
  forcePathStyle: process.env.S3_ENDPOINT   ? true : false, // required for MinIO/LocalStack

  // ─── AWS Secrets Manager ───────────────────────────────────────────────────
  // If set, CloudVault fetches credentials dynamically on startup.
  // The secret must be a JSON object with keys matching the env vars above.
  secretsManagerName: process.env.SECRETS_MANAGER_NAME || process.env.AWS_SECRET_NAME || null,

  // ─── SNS / SQS Event Notifications ────────────────────────────────────────
  sqsQueueUrl: process.env.AWS_SQS_QUEUE_URL || null,
  snsTopicArn: process.env.AWS_SNS_TOPIC_ARN || null,

  // ─── Intelligent Tiering ───────────────────────────────────────────────────
  tieringInactivityDays: parseInt(process.env.TIERING_INACTIVITY_DAYS || '30', 10),

  // ─── Lambda ────────────────────────────────────────────────────────────────
  lambdaFunctionName: process.env.LAMBDA_FUNCTION_NAME || null,
  eventBridgeRuleArn: process.env.EVENTBRIDGE_RULE_ARN || null,
};

/**
 * Builds the credential object for the AWS SDK.
 * Returns undefined when no explicit keys are set — lets the SDK
 * fall through to the IAM role / environment credential chain automatically.
 *
 * @returns {{ accessKeyId, secretAccessKey, sessionToken } | undefined}
 */
export function resolveCredentials() {
  if (!awsConfig.accessKeyId || !awsConfig.secretAccessKey) {
    // No explicit keys — SDK will use IAM role / EC2 instance profile / ECS task role
    return undefined;
  }

  const creds = {
    accessKeyId:     awsConfig.accessKeyId,
    secretAccessKey: awsConfig.secretAccessKey,
  };

  if (awsConfig.sessionToken) {
    creds.sessionToken = awsConfig.sessionToken;
  }

  return creds;
}

/**
 * Validates that the minimum required AWS config is present.
 * Logs clear warnings for anything missing — never throws, so the app
 * can still serve cached content even without S3 connectivity.
 */
export function validateAwsConfig() {
  const warnings = [];

  if (!awsConfig.hotBucket) {
    warnings.push('HOT_BUCKET (or S3_BUCKET_NAME) is not set — uploads will fail.');
  }

  if (!awsConfig.coldBucket) {
    warnings.push('COLD_BUCKET is not set — intelligent tiering will be disabled.');
  }

  if (!awsConfig.accessKeyId && !awsConfig.secretsManagerName) {
    warnings.push(
      'AWS_ACCESS_KEY_ID is not set and no Secrets Manager name configured. ' +
      'Relying on IAM role / instance profile for S3 access.'
    );
  }

  if (!awsConfig.sqsQueueUrl) {
    warnings.push('AWS_SQS_QUEUE_URL is not set — SQS event listener will not start.');
  }

  for (const w of warnings) {
    console.warn(`[AWS Config] ${w}`);
  }

  return warnings.length === 0;
}

export default awsConfig;
