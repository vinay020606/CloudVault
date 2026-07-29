import { runIntelligentTiering } from '../workers/tieringWorker.js';

/**
 * AWS Lambda Handler for Intelligent Storage Tiering.
 * Triggered nightly by Amazon EventBridge (CloudWatch Events) cron rule: cron(0 0 * * ? *)
 *
 * @param {Object} event - AWS Lambda Event payload
 * @param {Object} context - AWS Lambda Context object
 * @returns {Promise<Object>} AWS Lambda Response Format ({ statusCode, body })
 */
export async function handler(event = {}, context = {}) {
  console.log('[AWS Lambda Tiering Handler] Triggered by EventBridge schedule...');

  try {
    const inactivityDays = event.inactivityDays || parseInt(process.env.TIERING_INACTIVITY_DAYS || '30', 10);

    const report = await runIntelligentTiering(inactivityDays);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Intelligent Storage Tiering execution completed',
        timestamp: new Date().toISOString(),
        requestId: context.awsRequestId || 'local-test-id',
        report,
      }),
    };
  } catch (err) {
    console.error('[AWS Lambda Tiering Handler Error]:', err.message);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        error: 'Intelligent Storage Tiering execution failed',
        message: err.message,
      }),
    };
  }
}

export default {
  handler,
};
