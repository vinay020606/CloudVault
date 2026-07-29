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
      current_tier ENUM('HOT', 'COLD') DEFAULT 'HOT',
      last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      access_count INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY idx_tenant_path (tenant_id, file_path)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  try {
    await currentPool.query(createFilesTableSQL);

    // Safely add missing columns if upgrading existing table
    const alterQueries = [
      `ALTER TABLE files ADD COLUMN current_tier ENUM('HOT', 'COLD') DEFAULT 'HOT'`,
      `ALTER TABLE files ADD COLUMN last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
      `ALTER TABLE files ADD COLUMN access_count INT DEFAULT 1`,
    ];

    for (const q of alterQueries) {
      try {
        await currentPool.query(q);
      } catch (e) {
        // Ignore column already exists error (ER_DUP_FIELDNAME / 1060)
      }
    }

    console.log('[MySQL] Database tables and tiering schema initialized successfully.');
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
