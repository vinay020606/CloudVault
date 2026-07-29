/**
 * Singleflight Request Coalescing Service
 * Prevents Thundering Herd problems on S3 cache misses by coalescing concurrent requests
 * for the same missing file into a single execution.
 */

const inFlightRequests = new Map();

/**
 * Executes or joins an in-flight request for a given request key (e.g. tenantId:filePath).
 *
 * @param {string} requestKey - Unique request identifier
 * @param {Function} fetchFromS3Fn - Async function returning Promise<Buffer>
 * @returns {Promise<Buffer>} Resolved file buffer
 */
export async function execute(requestKey, fetchFromS3Fn) {
  if (inFlightRequests.has(requestKey)) {
    return await inFlightRequests.get(requestKey);
  }

  const requestPromise = (async () => {
    try {
      return await fetchFromS3Fn(requestKey);
    } finally {
      inFlightRequests.delete(requestKey);
    }
  })();

  inFlightRequests.set(requestKey, requestPromise);
  return await requestPromise;
}

export { inFlightRequests };

export default {
  execute,
  inFlightRequests,
};
