import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { checkAndEvict } from '../src/services/evictionService.js';

async function runEvictionTest() {
  console.log('--- [Test] Redis LRU File Eviction ---');

  const testTenantsDir = path.resolve('./storage/test_tenants_eviction');
  await fs.promises.rm(testTenantsDir, { recursive: true, force: true });

  const tenantId = 'tenant_evict';
  const fileKeyA = `${tenantId}:fileA.dat`;
  const fileKeyB = `${tenantId}:fileB.dat`;

  const pathA = path.join(testTenantsDir, tenantId, 'fileA.dat');
  const pathB = path.join(testTenantsDir, tenantId, 'fileB.dat');

  await fs.promises.mkdir(path.dirname(pathA), { recursive: true });

  // 5MB each
  const FIVE_MB = 5 * 1024 * 1024;
  await fs.promises.writeFile(pathA, Buffer.alloc(FIVE_MB, 'a'));
  await fs.promises.writeFile(pathB, Buffer.alloc(FIVE_MB, 'b'));

  // In-memory Mock Redis
  const mockStorage = {
    lru: [fileKeyA, fileKeyB], // fileKeyA is oldest
  };

  const mockRedis = {
    async zrange(key, start, stop) {
      return mockStorage.lru.slice(start, stop + 1);
    },
    async zrem(key, member) {
      mockStorage.lru = mockStorage.lru.filter((m) => m !== member);
    },
  };

  // Max cache size set to 7MB (total folder size is 10MB)
  await checkAndEvict(mockRedis, testTenantsDir, 7 * 1024 * 1024);

  // Assertions
  const fileAExists = fs.existsSync(pathA);
  const fileBExists = fs.existsSync(pathB);

  assert.strictEqual(fileAExists, false, 'Oldest file A MUST be evicted from local disk cache');
  assert.strictEqual(fileBExists, true, 'Newer file B MUST remain on local disk cache');

  // Clean up
  await fs.promises.rm(testTenantsDir, { recursive: true, force: true });
  console.log('✅ PASS: Eviction watcher correctly unlinked oldest file and retained newer file.');
}

runEvictionTest().catch((err) => {
  console.error('❌ FAIL: Eviction test error:', err);
  process.exit(1);
});
