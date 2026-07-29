import assert from 'assert';
import { execute, inFlightRequests } from '../src/services/singleflightService.js';

async function runSingleflightTest() {
  console.log('--- [Test] Singleflight Request Coalescing Service ---');

  const testFileKey = 'tenant_101:documents/report.pdf';
  let s3FetchCallCount = 0;

  // Mock fetchFromS3Fn simulating slow network download
  const mockFetchFromS3Fn = async (key) => {
    s3FetchCallCount++;
    console.log(`[S3 Mock] Fetching file ${key}... (Call #${s3FetchCallCount})`);
    await new Promise((resolve) => setTimeout(resolve, 150)); // 150ms delay
    return Buffer.from(`Data for file ${key}`);
  };

  // Launch 20 concurrent requests simultaneously
  console.log('Launching 20 concurrent requests for missing file...');
  const concurrentRequests = Array.from({ length: 20 }, () =>
    execute(testFileKey, mockFetchFromS3Fn)
  );

  // Assert inFlightRequests map has 1 entry while in flight
  assert.strictEqual(inFlightRequests.has(testFileKey), true, 'Map inFlightRequests should contain testFileKey during execution');

  // Wait for all requests to resolve
  const results = await Promise.all(concurrentRequests);

  // Assertions
  assert.strictEqual(results.length, 20, 'All 20 concurrent promises should resolve');
  assert.strictEqual(s3FetchCallCount, 1, 'fetchFromS3Fn MUST be called exactly ONCE');

  const expectedContent = `Data for file ${testFileKey}`;
  for (let i = 0; i < results.length; i++) {
    assert.strictEqual(
      results[i].toString(),
      expectedContent,
      `Request #${i + 1} should receive identical correct file content`
    );
  }

  // Assert map cleared after completion
  assert.strictEqual(inFlightRequests.has(testFileKey), false, 'Map inFlightRequests should delete file key after completion');

  console.log('✅ PASS: 20 concurrent requests successfully coalesced into 1 S3 download call.');
}

runSingleflightTest().catch((err) => {
  console.error('❌ FAIL: Singleflight test error:', err);
  process.exit(1);
});
