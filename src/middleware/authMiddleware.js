import { verifyAccessToken, hasPermission } from '../services/authService.js';

/**
 * Express middleware to authenticate tenant requests via Bearer JWT token or x-api-key.
 */
export function authenticateTenant(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const apiKey = req.headers['x-api-key'] || req.query.token;

  let token = null;

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (apiKey) {
    token = apiKey;
  }

  // Allow bypass in test / dev environments if explicitly enabled or if no token provided with header fallback
  const bypassAuth = process.env.DISABLE_AUTH === 'true';

  if (!token) {
    if (bypassAuth) {
      req.user = { tenantId: req.headers['x-tenant-id'] || 'default_tenant', role: 'ADMIN' };
      return next();
    }
    return res.status(401).json({
      error: 'Unauthorized: Missing Authentication Token',
      message: 'Please provide a valid Bearer token in the Authorization header or x-api-key header.',
    });
  }

  try {
    const decoded = verifyAccessToken(token);

    // Tenant Isolation Check: If route or header specifies tenantId, enforce match
    const requestedTenant = req.headers['x-tenant-id'] || req.params.tenantId;
    if (requestedTenant && requestedTenant !== decoded.tenantId && decoded.role !== 'ADMIN') {
      return res.status(403).json({
        error: 'Forbidden: Tenant Boundary Violation',
        message: `Token for tenant '${decoded.tenantId}' cannot access resources for tenant '${requestedTenant}'.`,
      });
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({
      error: 'Unauthorized: Invalid Token',
      details: err.message,
    });
  }
}

/**
 * Middleware factory enforcing Role-Based Access Control (RBAC).
 *
 * @param {string|string[]} allowedRoles - Role or array of roles permitted ('ADMIN', 'DEVELOPER', 'VIEWER')
 */
export function requireRole(allowedRoles) {
  const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized: User authentication required' });
    }

    const userRole = req.user.role || 'VIEWER';

    if (!rolesArray.includes(userRole) && userRole !== 'ADMIN') {
      return res.status(403).json({
        error: 'Forbidden: Insufficient Permissions',
        message: `Role '${userRole}' is not authorized to perform this operation. Required role(s): ${rolesArray.join(', ')}.`,
      });
    }

    next();
  };
}

export default {
  authenticateTenant,
  requireRole,
};
