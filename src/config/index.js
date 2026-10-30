import dotenv from 'dotenv';
import path from 'path';
import awsConfig, { validateAwsConfig } from './aws.js';

dotenv.config();

function loadConfiguration() {
  const config = {
    port: parseInt(process.env.PORT || '3000', 10),

    mysql: {
      host:     process.env.MYSQL_HOST     || 'localhost',
      port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
      user:     process.env.MYSQL_USER     || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'cloudvault',
    },

    redis: {
      host:     process.env.REDIS_HOST || 'localhost',
      port:     parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
    },

    storage: {
      blocksDir:        path.resolve(process.env.LOCAL_BLOCKS_DIR   || './storage/blocks'),
      tenantsDir:       path.resolve(process.env.TENANTS_STORAGE_DIR || './storage/tenants'),
      maxCacheSizeBytes:  parseInt(process.env.MAX_CACHE_SIZE_BYTES  || '104857600', 10), // 100 MB
      maxUploadSizeBytes: parseInt(process.env.MAX_UPLOAD_SIZE_BYTES || '0', 10),         // 0 = no limit
    },

    // AWS config is managed centrally in src/config/aws.js
    // Access it via config.s3.* for backwards compatibility
    s3: {
      get region()          { return awsConfig.region; },
      get accessKeyId()     { return awsConfig.accessKeyId; },
      get secretAccessKey() { return awsConfig.secretAccessKey; },
      get hotBucket()       { return awsConfig.hotBucket; },
      get coldBucket()      { return awsConfig.coldBucket; },
      get bucketName()      { return awsConfig.hotBucket; },
      get endpoint()        { return awsConfig.endpoint; },
    },

    tiering: {
      get inactivityDays() { return awsConfig.tieringInactivityDays; },
    },
  };

  // ── Port / DB validation ──────────────────────────────────────────────────
  if (isNaN(config.port) || config.port <= 0) {
    throw new Error(`Invalid PORT: "${process.env.PORT}"`);
  }
  if (isNaN(config.mysql.port) || config.mysql.port <= 0) {
    throw new Error(`Invalid MYSQL_PORT: "${process.env.MYSQL_PORT}"`);
  }
  if (isNaN(config.redis.port) || config.redis.port <= 0) {
    throw new Error(`Invalid REDIS_PORT: "${process.env.REDIS_PORT}"`);
  }

  // ── AWS readiness check (warnings only — app still starts) ────────────────
  validateAwsConfig();

  return config;
}

const config = loadConfiguration();

export default config;
