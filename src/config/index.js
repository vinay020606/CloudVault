import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

/**
 * Parses and validates system configuration settings from environment variables.
 */
function loadConfiguration() {
  const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    mysql: {
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || '3306', 10),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || 'root',
      database: process.env.MYSQL_DATABASE || 'cloudvault',
    },
    redis: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    },
    storage: {
      blocksDir: path.resolve(process.env.LOCAL_BLOCKS_DIR || './storage/blocks'),
      tenantsDir: path.resolve(process.env.TENANTS_STORAGE_DIR || './storage/tenants'),
      maxCacheSizeBytes: parseInt(process.env.MAX_CACHE_SIZE_BYTES || '104857600', 10), // Default 100MB
    },
    s3: {
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'mock_access_key',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'mock_secret_key',
      bucketName: process.env.S3_BUCKET_NAME || 'cloudvault-storage-bucket',
      endpoint: process.env.S3_ENDPOINT || undefined,
    },
  };

  // Basic validation checks
  if (isNaN(config.port) || config.port <= 0) {
    throw new Error(`Invalid PORT configuration: ${process.env.PORT}`);
  }

  if (isNaN(config.mysql.port) || config.mysql.port <= 0) {
    throw new Error(`Invalid MYSQL_PORT configuration: ${process.env.MYSQL_PORT}`);
  }

  if (isNaN(config.redis.port) || config.redis.port <= 0) {
    throw new Error(`Invalid REDIS_PORT configuration: ${process.env.REDIS_PORT}`);
  }

  return config;
}

const config = loadConfiguration();

export default config;
