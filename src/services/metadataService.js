import { query } from '../db/mysql.js';

/**
 * Inserts or updates a file record in MySQL.
 *
 * @param {string} tenantId - Tenant ID
 * @param {string} filePath - User requested file path
 * @param {string} fileName - Original file name
 * @param {number} sizeBytes - Total file size in bytes
 * @param {string} s3Key - S3 Object Key
 * @returns {Promise<Object>} Created/updated file metadata record
 */
export async function createFileRecord(tenantId, filePath, fileName, sizeBytes, s3Key) {
  const sql = `
    INSERT INTO files (tenant_id, file_path, file_name, size_bytes, s3_key, current_tier, last_accessed_at, access_count)
    VALUES (?, ?, ?, ?, ?, 'HOT', CURRENT_TIMESTAMP, 1)
    ON DUPLICATE KEY UPDATE
      file_name = VALUES(file_name),
      size_bytes = VALUES(size_bytes),
      s3_key = VALUES(s3_key),
      current_tier = 'HOT',
      last_accessed_at = CURRENT_TIMESTAMP,
      access_count = access_count + 1
  `;

  const result = await query(sql, [tenantId, filePath, fileName, sizeBytes, s3Key]);

  return {
    id: result.insertId,
    tenantId,
    filePath,
    fileName,
    sizeBytes,
    s3Key,
    currentTier: 'HOT',
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
    SELECT id, tenant_id, file_path, file_name, size_bytes, s3_key, current_tier, last_accessed_at, access_count, created_at
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
    currentTier: row.current_tier || 'HOT',
    lastAccessedAt: row.last_accessed_at,
    accessCount: Number(row.access_count || 1),
    createdAt: row.created_at,
  };
}

/**
 * Updates last_accessed_at timestamp and increments access_count for a file.
 *
 * @param {string} tenantId - Tenant ID
 * @param {string} filePath - User requested file path
 */
export async function touchFileAccess(tenantId, filePath) {
  const sql = `
    UPDATE files
    SET last_accessed_at = CURRENT_TIMESTAMP,
        access_count = access_count + 1
    WHERE tenant_id = ? AND file_path = ?
  `;
  try {
    await query(sql, [tenantId, filePath]);
  } catch (err) {
    console.warn(`[Metadata Warn] Failed to update access stats for ${filePath}:`, err.message);
  }
}

/**
 * Updates the storage tier of a file record in MySQL (HOT <-> COLD).
 *
 * @param {number} fileId - File ID
 * @param {string} newTier - 'HOT' or 'COLD'
 */
export async function updateFileTier(fileId, newTier) {
  const sql = `UPDATE files SET current_tier = ? WHERE id = ?`;
  await query(sql, [newTier, fileId]);
}

/**
 * Retrieves all files registered for a specific tenant.
 *
 * @param {string} tenantId - Tenant ID
 * @returns {Promise<Array<Object>>} Array of file metadata objects
 */
export async function listTenantFiles(tenantId) {
  try {
    const sql = `
      SELECT id, tenant_id, file_path, file_name, size_bytes, s3_key, current_tier, last_accessed_at, access_count, created_at
      FROM files
      WHERE tenant_id = ?
      ORDER BY created_at DESC
    `;

    const rows = await query(sql, [tenantId]);
    if (!rows) return [];

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      filePath: row.file_path,
      fileName: row.file_name,
      sizeBytes: Number(row.size_bytes),
      s3Key: row.s3_key,
      currentTier: row.current_tier || 'HOT',
      lastAccessedAt: row.last_accessed_at,
      accessCount: Number(row.access_count || 1),
      createdAt: row.created_at,
    }));
  } catch (err) {
    console.warn(`[Metadata Warn] Failed to list files for tenant ${tenantId}:`, err.message);
    return [];
  }
}

/**
 * Deletes a file record from MySQL for a tenant.
 *
 * @param {string} tenantId - Tenant ID
 * @param {string} filePath - File path
 */
export async function deleteFileRecord(tenantId, filePath) {
  try {
    const sql = `DELETE FROM files WHERE tenant_id = ? AND file_path = ?`;
    await query(sql, [tenantId, filePath]);
  } catch (err) {
    console.warn(`[Metadata Warn] Failed to delete file record ${filePath}:`, err.message);
  }
}

export default {
  createFileRecord,
  getFileMetadata,
  touchFileAccess,
  updateFileTier,
  listTenantFiles,
  deleteFileRecord,
};
