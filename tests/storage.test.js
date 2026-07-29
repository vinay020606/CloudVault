import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { resolveTenantPath } from '../src/utils/pathSanitizer.js';

async function runStorageTest() {
  console.log('--- [Test] Direct Whole-File Tenant Storage ---');

  const tenantId = 'tenant_demo';
  const baseStorageDir = path.resolve('./storage/test_tenants');
  await fs.promises.rm(baseStorageDir, { recursive: true, force: true });

  const targetPath = 'documents/report.pdf';
  const resolvedPath = resolveTenantPath(tenantId, targetPath, baseStorageDir);

  const sampleData = Buffer.from('CloudVault sample file content data');
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(resolvedPath, sampleData);

  // Assertions
  assert.strictEqual(fs.existsSync(resolvedPath), true, 'File must exist at tenant storage path');
  const readBack = await fs.promises.readFile(resolvedPath);
  assert.strictEqual(readBack.toString(), sampleData.toString(), 'Read content must match sample data');

  // Cleanup
  await fs.promises.rm(baseStorageDir, { recursive: true, force: true });
  console.log('✅ PASS: Direct whole-file tenant storage successfully verified.');
}

runStorageTest().catch((err) => {
  console.error('❌ FAIL: Storage test error:', err);
  process.exit(1);
});
