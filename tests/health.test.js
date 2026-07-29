import assert from 'assert';
import { calculateTenantsFolderSize } from '../src/services/evictionService.js';
import config from '../src/config/index.js';

async function runHealthMetricsTest() {
  console.log('--- [Test] Health & Storage Metrics Monitoring ---');

  // Verify storage metric calculation logic
  const metrics = await calculateTenantsFolderSize(config.storage.tenantsDir);

  assert(typeof metrics.totalSizeBytes === 'number', 'totalSizeBytes must be a number');
  assert(Array.isArray(metrics.files), 'files must be an array');

  console.log(`Current storage metrics: Used=${metrics.totalSizeBytes} B, FileCount=${metrics.files.length}`);
  console.log('✅ PASS: Health & storage metrics monitoring successfully verified.');
}

runHealthMetricsTest().catch((err) => {
  console.error('❌ FAIL: Health metrics test error:', err);
  process.exit(1);
});
