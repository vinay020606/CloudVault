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
const inMemoryFileStore = new Map();

/**
 * Inserts or updates a file record in MySQL with in-memory fallback.
 *
 * @param {string} tenantId - Tenant ID
 * @param {string} filePath - User requested file path
 * @param {string} fileName - Original file name
 * @param {number} sizeBytes - Total file size in bytes
 * @param {string} s3Key - S3 Object Key
 * @returns {Promise<Object>} Created/updated file metadata record
 */
export async function createFileRecord(tenantId, filePath, fileName, sizeBytes, s3Key) {
  const fileRecord = {
    id: Date.now(),
    tenantId,
    filePath,
    fileName,
    sizeBytes: Number(sizeBytes || 0),
    s3Key,
    currentTier: 'HOT',
    lastAccessedAt: new Date(),
    accessCount: 1,
    createdAt: new Date(),
  };

  try {
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
    if (result && result.insertId) {
      fileRecord.id = result.insertId;
    }
  } catch (err) {
    console.warn(`[Metadata Warning] MySQL write skipped: ${err.message}. Using fallback memory store.`);
  }

  // Always sync to in-memory store for instant zero-downtime lookups
  const storeKey = `${tenantId}:${filePath}`;
  inMemoryFileStore.set(storeKey, fileRecord);

  return fileRecord;
}

/**
 * Retrieves file metadata for a specific tenant and file path.
 */
export async function getFileMetadata(tenantId, filePath) {
  try {
    const sql = `
      SELECT id, tenant_id, file_path, file_name, size_bytes, s3_key, current_tier, last_accessed_at, access_count, created_at
      FROM files
      WHERE tenant_id = ? AND file_path = ?
    `;

    const rows = await query(sql, [tenantId, filePath]);

    if (rows && rows.length > 0) {
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
  } catch (err) {
    console.warn(`[Metadata Warn] MySQL lookup fallback for ${tenantId}:${filePath}:`, err.message);
  }

  // Fallback to in-memory store
  const storeKey = `${tenantId}:${filePath}`;
  return inMemoryFileStore.get(storeKey) || null;
}

/**
 * Updates last_accessed_at timestamp and increments access_count.
 */
export async function touchFileAccess(tenantId, filePath) {
  try {
    const sql = `
      UPDATE files
      SET last_accessed_at = CURRENT_TIMESTAMP, access_count = access_count + 1
      WHERE tenant_id = ? AND file_path = ?
    `;
    await query(sql, [tenantId, filePath]);
  } catch (err) {
    console.warn(`[Metadata Warn] Touch access warning:`, err.message);
  }

  const storeKey = `${tenantId}:${filePath}`;
  const record = inMemoryFileStore.get(storeKey);
  if (record) {
    record.lastAccessedAt = new Date();
    record.accessCount = (record.accessCount || 0) + 1;
  }
}

/**
 * Updates storage tier for a file record.
 */
export async function updateFileTier(tenantId, filePath, newTier) {
  try {
    const sql = `
      UPDATE files
      SET current_tier = ?
      WHERE tenant_id = ? AND file_path = ?
    `;
    await query(sql, [newTier, tenantId, filePath]);
  } catch (err) {
    console.warn(`[Metadata Warn] Update tier warning:`, err.message);
  }

  const storeKey = `${tenantId}:${filePath}`;
  const record = inMemoryFileStore.get(storeKey);
  if (record) {
    record.currentTier = newTier;
  }
}

/**
 * Retrieves all file records for a specific tenant.
 */
export async function listTenantFiles(tenantId) {
  const fileMap = new Map();

  // Load from MySQL if available
  try {
    const sql = `
      SELECT id, tenant_id, file_path, file_name, size_bytes, s3_key, current_tier, last_accessed_at, access_count, created_at
      FROM files
      WHERE tenant_id = ?
      ORDER BY created_at DESC
    `;

    const rows = await query(sql, [tenantId]);
    if (rows && Array.isArray(rows)) {
      rows.forEach((row) => {
        fileMap.set(row.file_path, {
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
        });
      });
    }
  } catch (err) {
    console.warn(`[Metadata Warn] Failed querying MySQL files for ${tenantId}: ${err.message}. Using fallback store.`);
  }

  // Merge in-memory records
  for (const [key, record] of inMemoryFileStore.entries()) {
    if (key.startsWith(`${tenantId}:`) && !fileMap.has(record.filePath)) {
      fileMap.set(record.filePath, record);
    }
  }

  return Array.from(fileMap.values());
}

/**
 * Deletes a file record for a tenant.
 */
export async function deleteFileRecord(tenantId, filePath) {
  try {
    const sql = `DELETE FROM files WHERE tenant_id = ? AND file_path = ?`;
    await query(sql, [tenantId, filePath]);
  } catch (err) {
    console.warn(`[Metadata Warn] Failed MySQL delete for ${filePath}:`, err.message);
  }

  const storeKey = `${tenantId}:${filePath}`;
  inMemoryFileStore.delete(storeKey);
}

export default {
  createFileRecord,
  getFileMetadata,
  touchFileAccess,
  updateFileTier,
  listTenantFiles,
  deleteFileRecord,
};
