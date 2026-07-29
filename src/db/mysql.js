import mysql from 'mysql2/promise';
import config from '../config/index.js';

let pool = null;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return pool;
}

export async function initDB() {
  const currentPool = getPool();

  const createFilesTableSQL = `
    CREATE TABLE IF NOT EXISTS files (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id VARCHAR(255) NOT NULL,
      file_path VARCHAR(768) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      size_bytes BIGINT NOT NULL,
      s3_key VARCHAR(1024) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY idx_tenant_path (tenant_id, file_path)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  try {
    await currentPool.query(createFilesTableSQL);
    console.log('[MySQL] Database tables initialized successfully.');
  } catch (err) {
    console.error('[MySQL] Database initialization error:', err.message);
  }
}

export async function query(sql, params) {
  const p = getPool();
  const [results] = await p.execute(sql, params);
  return results;
}

export default {
  getPool,
  initDB,
  query,
};
