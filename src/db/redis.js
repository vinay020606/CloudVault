import Redis from 'ioredis';
import config from '../config/index.js';

let redisClient = null;

export function getRedisClient() {
  if (!redisClient) {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    redisClient.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });
  }
  return redisClient;
}

export default getRedisClient;
