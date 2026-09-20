import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../config/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'cloudvault_super_secret_jwt_key_2026';

export const ROLES = {
  ADMIN: 'ADMIN',
  DEVELOPER: 'DEVELOPER',
  VIEWER: 'VIEWER',
};

export const PERMISSIONS = {
  [ROLES.ADMIN]: ['read', 'write', 'delete', 'invalidate', 'admin'],
  [ROLES.DEVELOPER]: ['read', 'write'],
  [ROLES.VIEWER]: ['read'],
};

/**
 * Generates a signed JWT access token for a tenant and role.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant identifier
 * @param {string} [params.userId='user_101'] - User ID
 * @param {string} [params.role='DEVELOPER'] - User role ('ADMIN', 'DEVELOPER', 'VIEWER')
 * @param {string|number} [params.expiresIn='24h'] - Token expiration
 * @returns {string} Signed JWT token
 */
export function generateAccessToken({ tenantId, userId = 'user_101', role = ROLES.DEVELOPER, expiresIn = '24h' }) {
  if (!tenantId) {
    throw new Error('Tenant ID is required to generate access token');
  }

  const validRole = ROLES[role.toUpperCase()] || ROLES.VIEWER;
  const payload = {
    tenantId,
    userId,
    role: validRole,
    permissions: PERMISSIONS[validRole],
    iat: Math.floor(Date.now() / 1000),
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

/**
 * Verifies and decodes a JWT access token.
 *
 * @param {string} token - JWT string
 * @returns {Object} Decoded payload
 */
export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    throw new Error(`Invalid or expired token: ${err.message}`);
  }
}

/**
 * Checks if a given role has the required permission action.
 *
 * @param {string} role - User role ('ADMIN', 'DEVELOPER', 'VIEWER')
 * @param {string} action - Action ('read', 'write', 'delete', 'invalidate')
 * @returns {boolean}
 */
export function hasPermission(role, action) {
  const userPermissions = PERMISSIONS[role] || [];
  return userPermissions.includes(action);
}

export default {
  ROLES,
  PERMISSIONS,
  generateAccessToken,
  verifyAccessToken,
  hasPermission,
};
