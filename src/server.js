import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import fs from 'fs';
import path from 'path';
import config from './config/index.js';
import { initDB } from './db/mysql.js';
import { getRedisClient } from './db/redis.js';
import { startEvictionWatcher } from './services/evictionService.js';
import gatewayRoutes from './routes/gateway.js';
import proxyRoutes from './routes/proxy.js';

const app = express();

// Security and CORS middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Serve static frontend files if any exist
app.use(express.static('public'));

// Gateway & Storage Proxy Routes
app.use('/api/v1/gateway', gatewayRoutes);
app.use('/proxy', proxyRoutes);

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'online', service: 'CloudVault Gateway', timestamp: new Date().toISOString() });
});

async function startServer() {
  console.log('🚀 Starting CloudVault Gateway Server...');

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

  const PORT = config.port;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ CloudVault Gateway listening at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('❌ Server startup error:', err);
  process.exit(1);
});

export default app;
