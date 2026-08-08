import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * Dynamically fetches JSON secrets from AWS Secrets Manager
 * Prevents hardcoding sensitive credentials in local .env files or git repositories.
 *
 * @param {string} secretName - AWS Secrets Manager Secret ID / Name
 * @param {string} [region='us-east-1'] - AWS Region
 * @returns {Promise<Record<string, string>|null>} Parsed JSON key-value secret pairs
 */
export async function fetchAwsSecret(secretName, region = 'us-east-1') {
  if (!secretName) return null;

  try {
    const client = new SecretsManagerClient({ region });
    const response = await client.send(
      new GetSecretValueCommand({
        SecretId: secretName,
      })
    );

    if (response.SecretString) {
      const secret = JSON.parse(response.SecretString);
      console.log(`[Secrets Manager] Successfully retrieved dynamic credentials from AWS Secrets Manager (${secretName})`);
      return secret;
    }
  } catch (err) {
    console.warn(`[Secrets Manager Info] Skipped AWS Secrets Manager lookup (${secretName}):`, err.message);
  }
  return null;
}

export default {
  fetchAwsSecret,
};
