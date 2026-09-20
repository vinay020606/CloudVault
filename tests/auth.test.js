import assert from 'assert';
import { generateAccessToken, verifyAccessToken, hasPermission, ROLES } from '../src/services/authService.js';

async function runAuthTest() {
  console.log('--- [Test] Authentication & Role-Based Access Control (RBAC) ---');

  const tenantId = 'tenant_security_test';

  // 1. Test JWT Generation & Verification
  const adminToken = generateAccessToken({ tenantId, role: ROLES.ADMIN, userId: 'admin_1' });
  assert.ok(adminToken, 'Admin JWT token must be generated');

  const decodedAdmin = verifyAccessToken(adminToken);
  assert.strictEqual(decodedAdmin.tenantId, tenantId, 'Decoded tenantId must match');
  assert.strictEqual(decodedAdmin.role, 'ADMIN', 'Decoded role must be ADMIN');

  // 2. Test Permission Matrix Checks
  assert.strictEqual(hasPermission(ROLES.ADMIN, 'delete'), true, 'ADMIN must have delete permission');
  assert.strictEqual(hasPermission(ROLES.DEVELOPER, 'write'), true, 'DEVELOPER must have write permission');
  assert.strictEqual(hasPermission(ROLES.DEVELOPER, 'delete'), false, 'DEVELOPER must NOT have delete permission');
  assert.strictEqual(hasPermission(ROLES.VIEWER, 'read'), true, 'VIEWER must have read permission');
  assert.strictEqual(hasPermission(ROLES.VIEWER, 'write'), false, 'VIEWER must NOT have write permission');

  // 3. Test Invalid Token Handling
  assert.throws(() => {
    verifyAccessToken('invalid.token.string');
  }, /Invalid or expired token/, 'Invalid token must throw error');

  // 4. Test Tenant Isolation Guard
  const tenantAToken = generateAccessToken({ tenantId: 'tenant_alpha', role: ROLES.DEVELOPER });
  const decodedA = verifyAccessToken(tenantAToken);
  assert.strictEqual(decodedA.tenantId, 'tenant_alpha');

  console.log('✅ PASS: Authentication service, JWT verification, and RBAC matrix successfully verified.');
}

runAuthTest().catch((err) => {
  console.error('❌ FAIL: Auth test error:', err);
  process.exit(1);
});
