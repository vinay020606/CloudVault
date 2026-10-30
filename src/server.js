import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import config from './config/index.js';
import { initDB } from './db/mysql.js';
import { getRedisClient } from './db/redis.js';
import { startEvictionWatcher } from './services/evictionService.js';
import { startTieringCron } from './workers/tieringWorker.js';
import { startS3UploadWorker } from './workers/s3UploadWorker.js';
import gatewayRoutes from './routes/gateway.js';
import proxyRoutes from './routes/proxy.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import requestLogger from './middleware/requestLogger.js';

import { applyAwsSecrets } from './services/secretsService.js';
import awsConfig from './config/aws.js';

const app = express();

// Security, CORS, and logging middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(requestLogger);

// Serve static frontend files if any exist
app.use(express.static('public'));

// Gateway, Proxy, Health, and Auth Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/gateway', gatewayRoutes);
app.use('/proxy', proxyRoutes);
app.use('/health', healthRoutes);

async function startServer() {
  console.log('🚀 Starting CloudVault Gateway Server...');

  // Load credentials from AWS Secrets Manager if configured (overrides env vars)
  if (awsConfig.secretsManagerName) {
    const secrets = await applyAwsSecrets(awsConfig.secretsManagerName, awsConfig.region);
    if (secrets?.MYSQL_PASSWORD) {
      config.mysql.password = secrets.MYSQL_PASSWORD;
    }
    if (secrets?.REDIS_PASSWORD) {
      config.redis.password = secrets.REDIS_PASSWORD;
    }
  }

  // Ensure local storage directories exist
  await fs.promises.mkdir(config.storage.blocksDir, { recursive: true });
  await fs.promises.mkdir(config.storage.tenantsDir, { recursive: true });

  // Initialize MySQL Connection Pool and Tables
  await initDB();

  // Initialize Redis Connection
  const redis = getRedisClient();

  // Start background LRU & Ref-Count Eviction Watcher
  startEvictionWatcher(redis, {
    blocksDir: config.storage.blocksDir,
    maxCacheSizeBytes: config.storage.maxCacheSizeBytes,
    intervalMs: 30000, // Runs every 30 seconds
  });

  // Start background Intelligent Storage Tiering Worker
  startTieringCron(86400000); // Nightly scan every 24 hours

  // Start background BullMQ S3 Upload Worker
  startS3UploadWorker({ concurrency: 5 });

  const PORT = config.port;
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ CloudVault Gateway listening at http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use. Set a different PORT in .env.`);
    } else {
      console.error('❌ Server error:', err.message);
    }
    process.exit(1);
  });
}

startServer().catch((err) => {
  console.error('❌ Server startup error:', err);
  process.exit(1);
});

export default app;
