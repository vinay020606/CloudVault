import { query } from '../db/mysql.js';

/**
 * Inserts or updates a whole-file record in MySQL.
 *
 * @param {string} tenantId - Tenant ID
 * @param {string} filePath - User requested file path
 * @param {string} fileName - Original file name
 * @param {number} sizeBytes - Total file size in bytes
 * @param {string} s3Key - S3 Object Key (e.g. tenants/<tenantId>/<filePath>)
 * @returns {Promise<Object>} Created/updated file metadata record
 */
export async function createFileRecord(tenantId, filePath, fileName, sizeBytes, s3Key) {
  const sql = `
    INSERT INTO files (tenant_id, file_path, file_name, size_bytes, s3_key)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      file_name = VALUES(file_name),
      size_bytes = VALUES(size_bytes),
      s3_key = VALUES(s3_key),
      created_at = CURRENT_TIMESTAMP
  `;

  const result = await query(sql, [tenantId, filePath, fileName, sizeBytes, s3Key]);

  return {
    id: result.insertId,
    tenantId,
    filePath,
    fileName,
    sizeBytes,
    s3Key,
  };
}

/**
 * Retrieves file metadata for a specific tenant and file path from MySQL.
 *
 * @param {string} tenantId - Tenant ID
 * @param {string} filePath - User requested file path
 * @returns {Promise<Object|null>} File metadata object or null if not found
 */
export async function getFileMetadata(tenantId, filePath) {
  const sql = `
    SELECT id, tenant_id, file_path, file_name, size_bytes, s3_key, created_at
    FROM files
    WHERE tenant_id = ? AND file_path = ?
    LIMIT 1
  `;

  const rows = await query(sql, [tenantId, filePath]);

  if (!rows || rows.length === 0) {
    return null;
  }

  const row = rows[0];

  return {
    id: row.id,
    tenantId: row.tenant_id,
    filePath: row.file_path,
    fileName: row.file_name,
    sizeBytes: Number(row.size_bytes),
    s3Key: row.s3_key,
    createdAt: row.created_at,
  };
}

export default {
  createFileRecord,
  getFileMetadata,
};
