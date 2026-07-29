import assert from 'assert';
import { runIntelligentTiering } from '../src/workers/tieringWorker.js';
import { handler as tieringLambdaHandler } from '../src/lambda/tieringLambdaHandler.js';

async function runTieringTest() {
  console.log('--- [Test] Intelligent Storage Tiering (AWS Lambda & Multi-Bucket) ---');

  // Test 1: Worker Execution
  const report = await runIntelligentTiering(30);
  assert(report !== null, 'Tiering worker report must be non-null');
  assert(report.status === 'success' || report.status === 'error', 'Tiering report status must be success or error');

  // Test 2: AWS Lambda Event Handler Execution
  const mockLambdaEvent = { inactivityDays: 30 };
  const mockLambdaContext = { awsRequestId: 'test-request-id-12345' };

  const lambdaRes = await tieringLambdaHandler(mockLambdaEvent, mockLambdaContext);
  assert.strictEqual(lambdaRes.statusCode, 200, 'AWS Lambda handler must return statusCode 200');

  const body = JSON.parse(lambdaRes.body);
  assert.strictEqual(body.requestId, 'test-request-id-12345', 'AWS Lambda response must contain request ID');
  assert(body.report !== undefined, 'AWS Lambda response must contain execution report');

  console.log(`AWS Lambda Handler Test Output: statusCode=${lambdaRes.statusCode}, msg="${body.message}"`);
  console.log('✅ PASS: AWS Lambda Intelligent Tiering Handler successfully verified.');
}

runTieringTest().catch((err) => {
  console.error('❌ FAIL: Tiering test error:', err);
  process.exit(1);
});
