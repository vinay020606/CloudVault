import assert from 'assert';
import path from 'path';
import { resolveTenantPath, SecurityError } from '../src/utils/pathSanitizer.js';

async function runPathSanitizerTest() {
  console.log('--- [Test] Multi-Tenant Path Sanitizer ---');

  const tenantId = 'tenant_alpha';
  const baseDir = path.resolve('./storage/tenants');

  // Test 1: Valid relative subpath
  const valid1 = resolveTenantPath(tenantId, 'documents/notes.txt', baseDir);
  const expected1 = path.resolve(baseDir, tenantId, 'documents/notes.txt');
  assert.strictEqual(valid1, expected1, 'Valid path should resolve correctly under tenant dir');

  // Test 2: Valid root path under tenant
  const valid2 = resolveTenantPath(tenantId, '/profile.png', baseDir);
  const expected2 = path.resolve(baseDir, tenantId, 'profile.png');
  assert.strictEqual(valid2, expected2, 'Leading slash path should resolve correctly under tenant dir');

  // Test 3: Path traversal attempt with ../
  let errorThrown = false;
  try {
    resolveTenantPath(tenantId, '../tenant_beta/secret.txt', baseDir);
  } catch (err) {
    errorThrown = true;
    assert(err instanceof SecurityError, 'Error must be instance of SecurityError');
    console.log('Successfully caught traversal attack 1:', err.message);
  }
  assert.strictEqual(errorThrown, true, 'Path traversal attempt should throw SecurityError');

  // Test 4: Deep path traversal attempt
  errorThrown = false;
  try {
    resolveTenantPath(tenantId, 'sub/../../../../etc/passwd', baseDir);
  } catch (err) {
    errorThrown = true;
    assert(err instanceof SecurityError, 'Error must be instance of SecurityError');
    console.log('Successfully caught traversal attack 2:', err.message);
  }
  assert.strictEqual(errorThrown, true, 'Deep path traversal attempt should throw SecurityError');

  console.log('✅ PASS: Path sanitizer successfully allowed valid paths and blocked path traversal attacks.');
}

runPathSanitizerTest().catch((err) => {
  console.error('❌ FAIL: Path sanitizer test error:', err);
  process.exit(1);
});
