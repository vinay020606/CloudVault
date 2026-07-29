import crypto from 'crypto';

/**
 * Middleware that assigns a unique request ID, measures request duration,
 * and sets X-Request-ID and X-Response-Time response headers.
 */
export function requestLogger(req, res, next) {
  const reqId = crypto.randomUUID();
  req.id = reqId;
  const start = performance.now();

  res.setHeader('X-Request-ID', reqId);

  res.on('finish', () => {
    const duration = (performance.now() - start).toFixed(2);
    res.setHeader('X-Response-Time', `${duration}ms`);
    console.log(`[HTTP Proxy Log] ${req.method} ${req.originalUrl} -> Status ${res.statusCode} (${duration}ms) [ReqID: ${reqId.substring(0, 8)}]`);
  });

  next();
}

export default requestLogger;
