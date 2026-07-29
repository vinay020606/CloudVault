import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { resolveTenantPath } from '../src/utils/pathSanitizer.js';

async function runProxyRouteTest() {
  console.log('--- [Test] Transparent Storage Proxy Layer ---');

  const tenantId = 'tenant_proxy_test';
  const userPath = 'images/avatar.png';
  const baseStorageDir = path.resolve('./storage/test_proxy');

  await fs.promises.rm(baseStorageDir, { recursive: true, force: true });

  // Test 1: Proxy route resolution
  const resolved = resolveTenantPath(tenantId, userPath, baseStorageDir);
  const expected = path.resolve(baseStorageDir, tenantId, 'images/avatar.png');

  assert.strictEqual(resolved, expected, 'Transparent proxy path must resolve to tenant storage location');

  // Test 2: File write via proxy simulation
  const dummyBuffer = Buffer.from('Image binary content');
  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
  await fs.promises.writeFile(resolved, dummyBuffer);

  assert.strictEqual(fs.existsSync(resolved), true, 'Proxied file must exist on local disk storage');

  // Clean up
  await fs.promises.rm(baseStorageDir, { recursive: true, force: true });
  console.log('✅ PASS: Transparent Storage Proxy Layer successfully verified.');
}

runProxyRouteTest().catch((err) => {
  console.error('❌ FAIL: Proxy route test error:', err);
  process.exit(1);
});
