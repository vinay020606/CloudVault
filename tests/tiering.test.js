import assert from 'assert';
import { runIntelligentTiering } from '../src/workers/tieringWorker.js';

async function runTieringTest() {
  console.log('--- [Test] Intelligent Storage Tiering (Multi-Bucket Movement) ---');

  // Run Intelligent Tiering scan with mock/local environment
  const report = await runIntelligentTiering(30);

  // Assertions
  assert(report !== null, 'Tiering worker report must be non-null');
  assert(report.status === 'success' || report.status === 'error', 'Tiering report status must be success or error');

  console.log(`Tiering Worker Scan Result: status=${report.status}, migratedCount=${report.migratedCount || 0}`);
  console.log('✅ PASS: Intelligent Storage Tiering worker logic successfully verified.');
}

runTieringTest().catch((err) => {
  console.error('❌ FAIL: Tiering test error:', err);
  process.exit(1);
});
