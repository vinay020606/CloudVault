import path from 'path';
import config from '../config/index.js';

export class SecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecurityError';
    this.statusCode = 403;
  }
}

/**
 * Resolves and sanitizes a user requested path under a specific tenant directory.
 * Throws SecurityError if path traversal is attempted.
 *
 * @param {string} tenantId - Tenant identifier
 * @param {string} userRequestedPath - Path requested by user
 * @param {string} [baseStorageDir] - Optional custom base storage root
 * @returns {string} Sanitized absolute path within tenant storage
 */
export function resolveTenantPath(tenantId, userRequestedPath, baseStorageDir = null) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new SecurityError('Invalid tenant ID');
  }

  if (!userRequestedPath || typeof userRequestedPath !== 'string') {
    throw new SecurityError('Invalid target path');
  }

  const rootTenantsDir = path.resolve(baseStorageDir || config.storage.tenantsDir);
  const baseTenantFolder = path.resolve(rootTenantsDir, tenantId);

  // Normalize requested path and remove leading slashes/backslashes
  const normalizedUserPath = path.normalize(userRequestedPath).replace(/^(\/|\\)+/, '');

  // Resolve absolute target path
  const resolvedTarget = path.resolve(baseTenantFolder, normalizedUserPath);

  // Ensure target path is strictly inside baseTenantFolder or equals baseTenantFolder
  const tenantFolderWithSep = baseTenantFolder.endsWith(path.sep)
    ? baseTenantFolder
    : baseTenantFolder + path.sep;

  if (
    resolvedTarget !== baseTenantFolder &&
    !resolvedTarget.startsWith(tenantFolderWithSep)
  ) {
    throw new SecurityError(`Path traversal detected: Attempted to escape tenant root directory (${userRequestedPath})`);
  }

  return resolvedTarget;
}

export default {
  resolveTenantPath,
  SecurityError,
};
