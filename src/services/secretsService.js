/**
 * Dynamically fetches JSON secrets from AWS Secrets Manager if installed.
 * Prevents hardcoding sensitive credentials in local .env files or git repositories.
 *
 * @param {string} secretName - AWS Secrets Manager Secret ID / Name
 * @param {string} [region='us-east-1'] - AWS Region
 * @returns {Promise<Record<string, string>|null>} Parsed JSON key-value secret pairs
 */
export async function fetchAwsSecret(secretName, region = 'us-east-1') {
  if (!secretName) return null;

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
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
    console.warn(`[Secrets Manager Info] AWS Secrets Manager lookup skipped (${secretName}):`, err.message);
  }
  return null;
}

export default {
  fetchAwsSecret,
};
