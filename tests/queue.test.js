import assert from 'assert';
import { addS3UploadJob, getS3UploadQueue } from '../src/services/queueService.js';

async function runQueueTest() {
  console.log('--- [Test] BullMQ Job Queue Service ---');

  const testPayload = {
    tenantId: 'tenant_test',
    filePath: 'documents/contract.pdf',
    targetLocalPath: '/tmp/storage/tenant_test/documents/contract.pdf',
    s3Key: 'tenants/tenant_test/documents/contract.pdf',
  };

  const result = await addS3UploadJob(testPayload);
  assert.ok(result, 'Queue service must return a result object');
  assert.ok(
    result.status === 'QUEUED' || result.status === 'FALLBACK_INLINE',
    'Status must be QUEUED or FALLBACK_INLINE'
  );

  if (result.status === 'QUEUED') {
    assert.ok(result.jobId, 'Enqueued job must return a jobId');
    console.log(`✅ Queue Job Enqueued: ${result.jobId}`);
  } else {
    console.log(`ℹ️ Redis unavailable in test env: Fallback mechanism triggered cleanly.`);
  }

  // Cleanup queue connection if active
  const queue = getS3UploadQueue();
  if (queue) {
    await queue.close().catch(() => {});
  }

  console.log('✅ PASS: BullMQ queue service & fallback handling verified.');
}

runQueueTest().catch((err) => {
  console.error('❌ FAIL: Queue test error:', err);
  process.exit(1);
});
