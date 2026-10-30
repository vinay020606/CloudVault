# CloudVault — Master Reference

> Complete project history, all 28 bugs, all improvements, deployment guide, infrastructure/networking architecture, and interview Q&A.

---

## Table of Contents

1. [What is CloudVault](#1-what-is-cloudvault)
2. [Project Structure](#2-project-structure)
3. [Original Codebase Assessment](#3-original-codebase-assessment)
4. [All Issues Found and Fixed](#4-all-issues-found-and-fixed)
5. [Improvements Made](#5-improvements-made)
6. [Architecture Deep Dive](#6-architecture-deep-dive)
7. [Infrastructure and Networking](#7-infrastructure-and-networking)
8. [Deployment Strategy](#8-deployment-strategy)
9. [Interview Q&A](#9-interview-qa)

---

## 1. What is CloudVault

CloudVault is a **multi-tenant storage gateway** that sits in front of AWS S3. Instead of clients hitting S3 directly, every upload and download routes through this Node.js server which:

- Caches frequently-accessed files on a local SSD (hot cache), eliminating repeated S3 egress costs
- Automatically tiers cold files from S3 Standard to Glacier via intelligent tiering
- Queues S3 uploads asynchronously through BullMQ so the client gets a 202 immediately
- Enforces tenant isolation — tenant A can never access tenant B's files
- Uses JWT RBAC (ADMIN / DEVELOPER / VIEWER) to control which operations are permitted

### Core Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 ESM (`"type": "module"`) |
| HTTP server | Express 4 |
| Queue | BullMQ (built on ioredis) |
| Cache index | Redis sorted set (LRU scoring) |
| Metadata store | MySQL 8 (`files` table) |
| Object store | AWS S3 (SDK v3) |
| Secret management | AWS Secrets Manager |
| Containerization | Docker / ECS Fargate |
| IaC | CloudFormation (single template) |

---

## 2. Project Structure

```
CloudVault/
├── src/
│   ├── server.js                 # Express app bootstrap, graceful shutdown
│   ├── config/
│   │   ├── index.js              # All env-var config (getters for live reads)
│   │   └── aws.js                # AWS client factory — S3, Secrets Manager
│   ├── routes/
│   │   ├── gateway.js            # Upload, download, delete (core file ops)
│   │   └── proxy.js              # Cache invalidation, health, metrics
│   ├── services/
│   │   ├── authService.js        # JWT sign/verify + RBAC
│   │   ├── evictionService.js    # LRU eviction loop (disk + Redis + MySQL)
│   │   ├── metadataService.js    # MySQL wrapper with in-memory FIFO cap
│   │   ├── queueService.js       # BullMQ queue wrapper + graceful timeout
│   │   ├── s3Service.js          # S3 upload / download helpers
│   │   ├── secretsService.js     # Secrets Manager pull + applyAwsSecrets()
│   │   └── syncTracker.js        # In-memory Set of pending-upload file keys
│   ├── workers/
│   │   ├── s3UploadWorker.js     # BullMQ worker: dequeues and uploads to S3
│   │   └── tieringWorker.js      # Cron: MySQL stale-access scan → Glacier move
│   └── middleware/
│       ├── auth.js               # requireAuth / requireRole middleware
│       └── requestLogger.js      # Per-request structured logging
├── public/
│   └── index.html                # Dark-theme single-page management UI
├── deploy/
│   ├── cloudformation/
│   │   └── infra.yml             # Full VPC → ECS → RDS → ElastiCache CF template
│   ├── ecs-task-definition.json  # ECS task definition skeleton (placeholder IDs)
│   └── scripts/
│       └── deploy.sh             # 5-step automated deploy script
├── scripts/
│   └── localstack-init.sh        # Auto-creates S3 buckets in LocalStack
├── docker-compose.yml            # Dev: MySQL + Redis only
├── docker-compose.demo.yml       # Demo: MySQL + Redis + LocalStack + App
├── Dockerfile                    # Non-root user, production deps only
├── .dockerignore
├── DOCS.md                       # API reference + config table
├── DEPLOYMENT.md                 # All 3 deployment options with commands
└── MASTER_REFERENCE.md           # This file
```

---

## 3. Original Codebase Assessment

### What worked on first read
- Clean ESM module structure throughout
- AWS SDK v3 used correctly (client-per-operation pattern)
- BullMQ with retry/backoff configured
- Path traversal protection existed via `resolveTenantPath` in gateway.js
- Singleflight coalescing existed for S3 cache-miss concurrent requests

### What was immediately broken (startup crash)
`src/routes/proxy.js` imported `hasPermission` directly from `../middleware/auth`:
```js
// BROKEN — hasPermission is not exported from auth middleware
import { requireAuth, requireRole, hasPermission } from '../middleware/auth.js';
```
`hasPermission` lives in `authService.js`. The server would crash before handling a single request.

### What was silently wrong (no crash, wrong behavior)
- Redis password config field existed but was never passed to any Redis connection
- MySQL password default was hardcoded as `'root'`
- BullMQ Queue and Worker also silently ignored Redis password
- Eviction loop had no termination cap — infinite loop possible
- Eviction used raw `path.join` instead of the sanitized `resolveTenantPath`
- Tiering worker deleted from hot bucket before confirming cold bucket write
- Download route buffered entire file into heap memory
- Headers-already-sent error possible in requestLogger
- Range end was never clamped — could exceed file size
- `res` variable was shadowed in nested callbacks
- No upload size limits
- No auth on `/health/metrics` or `/s3-event` webhook routes
- Silent JWT secret fallback produced no warning
- `DISABLE_AUTH=true` defaulted requesting user to ADMIN role
- Unbounded in-memory metadata Map — memory leak at scale

---

## 4. All Issues Found and Fixed

### Category: Critical — Server would not start

**Issue 1: `hasPermission` imported from wrong module**
- File: `src/routes/proxy.js`
- Encountered: First startup attempt — immediate crash with `SyntaxError: The requested module does not provide an export named 'hasPermission'`
- Fix: Changed import to `import { hasPermission } from '../services/authService.js'`

---

### Category: Security — Allows privilege escalation or unauthorized access

**Issue 2: `DISABLE_AUTH=true` defaulted user to ADMIN**
- File: `src/middleware/auth.js`
- Encountered: Testing dev mode — realized bypass mode gave full admin access to any request
- Before: `req.user = { role: 'ADMIN', tenantId: 'dev-tenant' }`
- After: `req.user = { role: 'DEVELOPER', tenantId: 'dev-tenant' }` + loud console.warn

**Issue 3: `/health/metrics` endpoint was unauthenticated**
- File: `src/routes/proxy.js`
- Encountered: Code audit — metrics expose queue depth, memory usage, Redis connection state
- Fix: Added `requireRole('ADMIN')` middleware before the handler

**Issue 4: `/s3-event` webhook was unauthenticated**
- File: `src/routes/proxy.js`
- Encountered: Code audit — any caller could POST fake S3 events to manipulate metadata
- Fix: Added `requireRole('ADMIN')` middleware before the handler

**Issue 5: No auth on token endpoint**
- File: `src/routes/proxy.js`
- Encountered: Audit — `POST /api/v1/auth/token` had no rate limiting or API key gate
- Fix: Added `TOKEN_API_KEY` environment variable check. Requests without matching key get 401.

**Issue 6: Silent JWT secret fallback**
- File: `src/config/index.js`
- Encountered: Audit — `jwtSecret: process.env.JWT_SECRET || 'fallback-secret'` meant production deployments with missing `JWT_SECRET` silently used a well-known secret
- Fix: Added `console.warn` when fallback is used, documented that production must set `JWT_SECRET`

**Issue 7: Path traversal in eviction invalidation**
- File: `src/services/evictionService.js` (`invalidateFileCache` function)
- Encountered: Audit — `path.join(tenantsDir, tenantId, userPath)` with attacker-controlled `userPath` of `../../etc/passwd` would escape tenant directory
- Fix: Replaced with `resolveTenantPath(tenantId, userPath, tenantsDir)` which uses `path.normalize` + `path.resolve` boundary enforcement

---

### Category: Data Loss — Could silently destroy data

**Issue 8: Tiering worker deleted hot file before confirming cold write**
- File: `src/workers/tieringWorker.js`
- Encountered: Code audit reviewing tiering flow line by line
- Before:
  ```js
  await moveToGlacier(file.s3Key);    // 1. upload to cold
  await deleteFromS3(file.s3Key, hotBucket);  // 2. delete from hot
  await updateTierInDB(file.id, 'cold');       // 3. update DB
  // If step 1 throws after partial upload, step 2 still ran → data gone
  ```
- After: Copy to cold → confirm → update DB → delete from hot. Any failure before DB update leaves hot copy intact.

**Issue 9: No syncTracker guard in eviction**
- File: `src/services/evictionService.js`
- Encountered: Race condition analysis — file queued for S3 upload could be evicted from disk before worker uploads it, resulting in a silent S3 upload failure with a missing file
- Fix: Added `isPendingSync(fileKey)` check. If pending, defer eviction by 1 hour via Redis ZSET score update instead of deleting.

---

### Category: Incorrect Behavior — Wrong results, not crashes

**Issue 10: Redis password never passed (3 locations)**
- Files: `src/db/redis.js`, `src/services/queueService.js`, `src/workers/s3UploadWorker.js`
- Encountered: Testing with Redis AUTH enabled — all three connections failed silently
- Before (all three): No `password` field in connection config object
- After: `password: config.redis.password || undefined` in all three

**Issue 11: MySQL password defaulted to `'root'`**
- File: `src/config/index.js`
- Encountered: Audit — `process.env.MYSQL_PASSWORD || 'root'` would silently use root password in production if env var missing
- Fix: Changed default to `''` (empty string forces explicit config)

**Issue 12: RFC 7233 Range end not clamped**
- File: `src/routes/gateway.js`
- Encountered: Testing with `Range: bytes=0-99999999999` on a 1MB file — server returned wrong Content-Range header
- Before: `end = parseInt(parts[1])`
- After: `end = Math.min(parseInt(parts[1]), totalSizeBytes - 1)`

**Issue 13: `res` variable shadowed in nested callbacks**
- Files: `src/routes/gateway.js`, `src/routes/proxy.js`
- Encountered: Code audit — outer `res` (Express response) shadowed by inner `res` (S3 SDK response) inside callback blocks, leading to subtle response-not-sent bugs
- Fix: Renamed inner S3 response variables to `s3Res`

**Issue 14: Tiering worker wasted cycles when buckets not configured**
- File: `src/workers/tieringWorker.js`
- Encountered: Running with partial AWS config — worker would query MySQL for stale files, then throw on every file because bucket names were null
- Fix: Early return with warning if `HOT_BUCKET` or `COLD_BUCKET` are null

**Issue 15: BullMQ duplicate job ID on retry**
- File: `src/services/queueService.js`
- Encountered: Retry testing — second upload of same file failed with "job already exists" because `jobId` was `${tenantId}:${filePath}` (static)
- Fix: Changed to `${tenantId}:${filePath}:${Date.now()}`

**Issue 16: `queue.add()` hangs when Redis is slow**
- File: `src/services/queueService.js`
- Encountered: Redis connection drop scenario — upload request would hang indefinitely waiting for BullMQ to enqueue
- Fix: `Promise.race([queue.add(...), new Promise((_, reject) => setTimeout(() => reject(new Error('Queue timeout')), 4000))])`

**Issue 17: No `enableOfflineQueue: false` on BullMQ Redis connections**
- Files: `src/services/queueService.js`, `src/workers/s3UploadWorker.js`
- Encountered: Redis outage scenario — ioredis default buffers commands in memory forever, causing memory growth
- Fix: `enableOfflineQueue: false` + `connectTimeout: 5000` in all BullMQ Redis configs

**Issue 18: `clearPendingSync` never called on job complete or fail**
- File: `src/workers/s3UploadWorker.js`
- Encountered: Code audit — files added to syncTracker Set on queue, but never removed. Eviction would defer every file forever.
- Fix: Added `worker.on('completed', ...)` and `worker.on('failed', ...)` handlers calling `clearPendingSync(job.data.fileKey)`

**Issue 19: In-memory metadata Map unbounded**
- File: `src/services/metadataService.js`
- Encountered: Scale analysis — Map grows forever with unique file keys, eventually consuming all heap
- Fix: FIFO eviction cap at 5000 entries using `Map.prototype.keys().next()` to find oldest

**Issue 20: MySQL ALTER TABLE catch swallowed all errors**
- File: `src/server.js` (schema init)
- Encountered: Audit — `catch(e) { console.log('Column exists') }` would hide real DB connection failures
- Fix: Check `e.errno === 1060` (ER_DUP_FIELDNAME) and only suppress that specific error; re-throw all others

**Issue 21: Root `server.js` was dead CJS file**
- File: `server.js` (project root, not `src/server.js`)
- Encountered: Exploring project — found a stale `require()`-based file that did nothing in an ESM project
- Fix: Deleted it

**Issue 22: Tests hung after completion**
- File: `tests/queue.test.js`
- Encountered: Running test suite — process never exited because BullMQ Worker held open Redis connection
- Fix: Added `queue.close()` in `afterAll` + `process.exit(0)` to force test runner exit

---

### Category: Performance / Reliability

**Issue 23: Download buffered entire file into heap**
- File: `src/routes/gateway.js`
- Encountered: Load testing with large files — heap exhaustion on concurrent 500MB downloads
- Before: `const fileBuffer = await fs.promises.readFile(targetLocalPath); res.end(fileBuffer.subarray(start, end+1))`
- After: `fs.createReadStream(targetLocalPath, { start, end }).pipe(res)` — streams directly to socket

**Issue 24: `ERR_HTTP_HEADERS_SENT` from requestLogger**
- File: `src/middleware/requestLogger.js`
- Encountered: Error log analysis — logger tried to set response header after streaming had already sent headers
- Fix: Added `if (!res.headersSent)` guard before all `res.setHeader()` calls

**Issue 25: No upload size limits**
- File: `src/routes/gateway.js`
- Encountered: Audit — no Content-Length check, no busboy `fileSize` limit; attacker could exhaust disk
- Fix: 5GB Content-Length pre-check + `busboy({ limits: { fileSize: 5 * 1024 * 1024 * 1024 } })`

**Issue 26: Eviction loop could run forever**
- File: `src/services/evictionService.js`
- Encountered: Analysis of syncTracker + eviction interaction — if all LRU keys are pending sync, the while loop pops, defers, re-inserts, pops again, forever
- Fix: `MAX_EVICTION_ITERATIONS = 500` counter; loop breaks with a warning if reached

**Issue 27: No `connectTimeout` on Redis connections**
- All Redis connection configs
- Encountered: Audit — without timeout, connection attempts during Redis restart would block indefinitely
- Fix: `connectTimeout: 5000` on all connection configs

**Issue 28: `requestLogger` set header before `requireAuth` could reject**
- File: `src/middleware/requestLogger.js`
- Encountered: Order of middleware review — logger ran first and could set `X-Request-Id` after auth had already sent 401
- Fix: Move logger after auth in middleware chain, or use `res.on('finish', ...)` to log after response completes

---

## 5. Improvements Made

### A. Full streaming download pipeline

Before this project, any download read the entire file into a Node.js Buffer before sending. For a 4GB file, that means 4GB of heap usage per concurrent download.

After: Every download is a `fs.createReadStream()` piped to the Express response socket. Memory usage for a 4GB download is ~64KB (the stream buffer). This supports Range requests (HTTP 206) natively — the stream just specifies `{ start, end }`.

```js
// Before
const fileBuffer = await fs.promises.readFile(targetLocalPath);
return res.end(fileBuffer.subarray(start, end + 1));

// After — stream directly, no buffer
const stat = await fs.promises.stat(targetLocalPath);
const totalSizeBytes = stat.size;
const start = rangeHeader ? parseInt(rangeHeader.split('=')[1].split('-')[0]) : 0;
const end = rangeHeader
  ? Math.min(parseInt(rangeHeader.split('=')[1].split('-')[1]) || totalSizeBytes - 1, totalSizeBytes - 1)
  : totalSizeBytes - 1;

res.setHeader('Content-Length', end - start + 1);
res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSizeBytes}`);
res.status(rangeHeader ? 206 : 200);
fs.createReadStream(targetLocalPath, { start, end }).pipe(res);
```

### B. AWS credentials skeleton — zero hardcoded values

`src/config/aws.js` is the single source of truth for all AWS configuration. It exposes `getS3Client()` and `resetS3Client()`. When `secretsService.applyAwsSecrets()` is called at startup, it updates `awsConfig` and calls `resetS3Client()` so the next S3 operation uses fresh credentials. No environment variable names are duplicated across files.

### C. Sync protection against race condition

`syncTracker.js` is a simple in-memory Set:
```js
const pendingSync = new Set();
export const markPendingSync = (key) => pendingSync.add(key);
export const clearPendingSync = (key) => pendingSync.delete(key);
export const isPendingSync = (key) => pendingSync.has(key);
```

Lifecycle: `markPendingSync` called when job enqueued → `clearPendingSync` called when job completes or permanently fails → eviction checks `isPendingSync` before deleting from disk.

Limitation (known): Set is in-process. Server restart clears it. Files queued before restart could theoretically be evicted before the worker re-picks the job. Mitigation: BullMQ persists jobs in Redis with retries, so the job will re-run and re-download from S3 if needed.

### D. LocalStack demo environment

One command runs a full working CloudVault including S3-compatible storage:
```bash
docker-compose -f docker-compose.demo.yml up --build
```
No AWS account, no credentials, no cost. LocalStack intercepts all S3 API calls. `scripts/localstack-init.sh` runs on startup to create the `cloudvault-hot` and `cloudvault-cold` buckets automatically.

### E. Production infrastructure as code

`deploy/cloudformation/infra.yml` is a single 600-line CloudFormation template that creates:
- VPC with public/private subnet pairs across 2 AZs
- Internet Gateway + route tables
- ALB with HTTP→HTTPS redirect
- ECS Fargate cluster, task definition, service
- RDS MySQL 8 in private subnets
- ElastiCache Redis 7 in private subnets
- S3 hot + cold buckets
- ECR repository
- Secrets Manager secret (empty scaffold for user to fill)
- IAM roles with least-privilege policies

---

## 6. Architecture Deep Dive

### Upload Flow

```
Client POST /api/v1/files/:tenantId
    │
    ├─► requireAuth + requireRole('DEVELOPER')
    │
    ├─► Content-Length check (> 5GB → 413)
    │
    ├─► busboy multipart parse (fileSize limit: 5GB)
    │
    ├─► resolveTenantPath() → validated disk path
    │
    ├─► Write file to ./storage/tenants/<tenantId>/<path>
    │
    ├─► Insert/update row in MySQL files table
    │
    ├─► markPendingSync(fileKey)
    │
    ├─► queueService.enqueueUpload(tenantId, filePath, s3Key)
    │       └─► Promise.race([queue.add(...), timeout(4000)])
    │           ├─► Success → respond 202 Accepted
    │           └─► Timeout → inline async S3 upload → respond 200
    │
    └─► Redis ZADD cloudvault:lru_files <timestamp> <fileKey>
```

### Download — Cache Hit

```
Client GET /api/v1/files/:tenantId/:filePath
    │
    ├─► requireAuth + requireRole('VIEWER')
    │
    ├─► resolveTenantPath() → validated disk path
    │
    ├─► fs.access(targetLocalPath) → file exists on disk
    │
    ├─► Touch Redis LRU: ZADD cloudvault:lru_files <now> <fileKey>
    │
    ├─► fs.stat() → totalSizeBytes
    │
    ├─► Parse Range header, clamp end to file size
    │
    └─► fs.createReadStream({ start, end }).pipe(res) → HTTP 206/200
```

### Download — Cache Miss

```
Client GET /api/v1/files/:tenantId/:filePath
    │
    ├─► fs.access fails → file not on disk
    │
    ├─► MySQL SELECT → get s3Key and current_tier
    │       └─► tier = 'cold' → 503 (Glacier restore required)
    │
    ├─► singleflightExecute(fileKey, async () => {
    │       Download from S3 hot bucket
    │       fs.mkdir + fs.writeFile to disk
    │       Touch Redis LRU
    │   })
    │       └─► Concurrent requests for same key wait on single Promise
    │
    └─► fs.createReadStream({ start, end }).pipe(res)
```

### LRU Eviction Loop

```
checkAndEvict(tenantId) called after each upload
    │
    ├─► Calculate disk usage: sum of file sizes in tenant dir
    │
    ├─► If usage < maxCacheSizeBytes → return (no-op)
    │
    └─► WHILE usage > maxCacheSizeBytes AND iterations < 500:
            │
            ├─► ZRANGE cloudvault:lru_files 0 0 (lowest score = LRU file)
            │
            ├─► isPendingSync(fileKey)?
            │       YES → ZADD defer by 1 hour → continue
            │       NO  → proceed
            │
            ├─► resolveTenantPath → validated disk path
            │
            ├─► fs.unlink(filePath)
            │
            ├─► ZREM cloudvault:lru_files <fileKey>
            │
            └─► Recalculate disk usage
```

### Tiering Cron (runs every 30 minutes)

```
runIntelligentTiering()
    │
    ├─► Guard: HOT_BUCKET and COLD_BUCKET configured? No → skip
    │
    ├─► MySQL SELECT files WHERE tier='hot' AND last_accessed_at < NOW() - 30 days
    │
    └─► For each stale file:
            │
            ├─► Upload s3Key from hotBucket to coldBucket (Glacier)
            │
            ├─► Confirm cold object exists (HeadObject)
            │
            ├─► MySQL UPDATE SET current_tier='cold'
            │
            └─► Delete from hotBucket
```

### MySQL Schema

```sql
CREATE TABLE files (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       VARCHAR(128) NOT NULL,
  file_path       VARCHAR(1024) NOT NULL,
  s3_key          VARCHAR(2048) NOT NULL,
  current_tier    ENUM('hot','cold') NOT NULL DEFAULT 'hot',
  file_size_bytes BIGINT UNSIGNED,
  content_type    VARCHAR(255),
  last_accessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tenant_path (tenant_id, file_path),
  INDEX idx_tier_last_accessed (current_tier, last_accessed_at)
);
```

### Redis Structure

```
cloudvault:lru_files   — Sorted set
  Key format: <tenantId>:<filePath>
  Score: Unix timestamp of last access (seconds)
  Operations: ZADD (touch), ZRANGE 0 0 (find LRU), ZREM (evict)
```

---

## 7. Infrastructure and Networking

### VPC Architecture

```
┌─────────────────────────────── VPC (10.0.0.0/16) ───────────────────────────────┐
│                                                                                   │
│  ┌────────── AZ-1 (us-east-1a) ──────────┐  ┌───── AZ-2 (us-east-1b) ─────────┐ │
│  │                                        │  │                                  │ │
│  │  ┌──── Public Subnet ────────────────┐ │  │ ┌── Public Subnet ─────────────┐ │ │
│  │  │  10.0.1.0/24                      │ │  │ │ 10.0.2.0/24                  │ │ │
│  │  │  ALB Node (half of ALB fleet)     │ │  │ │ ALB Node (other half)        │ │ │
│  │  └───────────────────────────────────┘ │  │ └──────────────────────────────┘ │ │
│  │                                        │  │                                  │ │
│  │  ┌──── Private Subnet ───────────────┐ │  │ ┌── Private Subnet ────────────┐ │ │
│  │  │  10.0.11.0/24                     │ │  │ │ 10.0.12.0/24                 │ │ │
│  │  │  ECS Fargate Tasks                │ │  │ │ ECS Fargate Tasks            │ │ │
│  │  │  (CloudVault containers)          │ │  │ │ (CloudVault containers)      │ │ │
│  │  └───────────────────────────────────┘ │  │ └──────────────────────────────┘ │ │
│  │                                        │  │                                  │ │
│  │  ┌──── Private Subnet ───────────────┐ │  │ ┌── Private Subnet ────────────┐ │ │
│  │  │  10.0.21.0/24                     │ │  │ │ 10.0.22.0/24                 │ │ │
│  │  │  RDS MySQL (primary)              │ │  │ │ RDS MySQL (standby)          │ │ │
│  │  │  ElastiCache Redis (primary)      │ │  │ │ ElastiCache Redis (replica)  │ │ │
│  │  └───────────────────────────────────┘ │  │ └──────────────────────────────┘ │ │
│  └────────────────────────────────────────┘  └──────────────────────────────────┘ │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
          │
          ▼ Internet Gateway
     Public Internet
```

### Security Groups

| Security Group | Inbound | Outbound |
|---|---|---|
| `sgALB` | 80 from 0.0.0.0/0, 443 from 0.0.0.0/0 | All to `sgApp` |
| `sgApp` | 3000 from `sgALB` only | All to `sgDB`, `sgRedis`, S3 endpoints |
| `sgDB` | 3306 from `sgApp` only | None |
| `sgRedis` | 6379 from `sgApp` only | None |

ECS tasks **never have public IPs**. All inbound traffic enters only through the ALB. Direct internet access to the app layer is impossible.

### Traffic Flow

```
User Browser
    │ HTTPS :443
    ▼
Application Load Balancer (public subnets)
    │ HTTP :3000 (internal)
    ▼
ECS Fargate Task (private app subnet)
    │ TCP :3306               │ TCP :6379           │ HTTPS :443
    ▼                         ▼                     ▼
RDS MySQL                ElastiCache Redis       S3 (via VPC endpoint recommended)
(private DB subnet)      (private DB subnet)     (AWS managed)
```

### IAM Roles

**ECSTaskExecutionRole** — what ECS needs to start the task:
- `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` — pull image from ECR
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` — write to CloudWatch
- `secretsmanager:GetSecretValue` — pull app secrets at startup

**ECSTaskRole** — what the running application needs:
- `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:HeadObject` on both buckets
- `s3:ListBucket` on both buckets
- `secretsmanager:GetSecretValue` — for runtime secret refresh

### Secrets Manager Secret Structure

```json
{
  "JWT_SECRET": "",
  "MYSQL_PASSWORD": "",
  "REDIS_PASSWORD": "",
  "AWS_ACCESS_KEY_ID": "",
  "AWS_SECRET_ACCESS_KEY": ""
}
```

The application calls `secretsService.applyAwsSecrets()` at startup. This pulls the secret, populates `process.env`, and calls `resetS3Client()` to reinitialize the AWS SDK client with the fetched credentials. No credentials appear in ECS task environment variables.

### Auto-Scaling

CloudFormation configures ECS Application Auto Scaling:
- Min: 1 task, Max: 5 tasks
- Scale-out: CPU > 70% for 2 minutes → add 1 task (cooldown: 60s)
- Scale-in: CPU < 70% for 2 minutes → remove 1 task (cooldown: 120s)

---

## 8. Deployment Strategy

### Option A: Local Development (Docker Compose)

Start MySQL + Redis only, run app with Node directly:
```bash
# Terminal 1
docker-compose up -d

# Terminal 2
cp .env.example .env
# Edit .env — set MYSQL_PASSWORD, JWT_SECRET, etc.
PORT=3099 node src/server.js
```
Access at http://localhost:3099

Note: PORT 3000 is occupied on the dev machine by BEACON Hygiene Portal. Use PORT=3099.

---

### Option B: Demo (LocalStack — no AWS account needed)

Full stack including S3-compatible storage:
```bash
docker-compose -f docker-compose.demo.yml up --build
```

What runs:
- MySQL 8 on port 3306
- Redis 7 on port 6379
- LocalStack (S3 emulation) on port 4566
- CloudVault app on port 3000

LocalStack init script automatically creates:
- `s3://cloudvault-hot` with versioning enabled
- `s3://cloudvault-cold`

---

### Option C: Production (ECS Fargate + CloudFormation)

**Step 1 — Deploy infrastructure**
```bash
aws cloudformation deploy \
  --template-file deploy/cloudformation/infra.yml \
  --stack-name cloudvault-prod \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      Environment=production \
      DBPassword=<your-db-password>
```

**Step 2 — Fill Secrets Manager**
```bash
# Get the secret ARN from CF outputs
SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`SecretsManagerARN`].OutputValue' \
  --output text)

aws secretsmanager put-secret-value \
  --secret-id $SECRET_ARN \
  --secret-string '{
    "JWT_SECRET": "<your-jwt-secret>",
    "MYSQL_PASSWORD": "<your-db-password>",
    "REDIS_PASSWORD": "",
    "AWS_ACCESS_KEY_ID": "",
    "AWS_SECRET_ACCESS_KEY": ""
  }'
```

**Step 3 — Build and push Docker image**
```bash
ECR_URI=$(aws cloudformation describe-stacks \
  --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`ECRRepositoryURI`].OutputValue' \
  --output text)

aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin $ECR_URI

docker build -t cloudvault .
docker tag cloudvault:latest $ECR_URI:latest
docker push $ECR_URI:latest
```

**Step 4 — Register ECS task definition**
```bash
# Fill placeholders in task definition
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1

sed -e "s/<ACCOUNT_ID>/$ACCOUNT_ID/g" \
    -e "s/<REGION>/$REGION/g" \
    deploy/ecs-task-definition.json > /tmp/task-def-filled.json

aws ecs register-task-definition --cli-input-json file:///tmp/task-def-filled.json
```

**Step 5 — Deploy to ECS**
```bash
CLUSTER=$(aws cloudformation describe-stacks \
  --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterName`].OutputValue' \
  --output text)

SERVICE=$(aws cloudformation describe-stacks \
  --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`ECSServiceName`].OutputValue' \
  --output text)

aws ecs update-service \
  --cluster $CLUSTER \
  --service $SERVICE \
  --force-new-deployment

aws ecs wait services-stable --cluster $CLUSTER --services $SERVICE
echo "Deployment complete"
```

---

## 9. Interview Q&A

### System Design

**Q: How does CloudVault prevent the Thundering Herd problem?**

A: When a file isn't in the local cache, multiple concurrent requests for the same file would all go to S3 simultaneously — multiplying egress cost and latency. CloudVault uses a singleflight pattern: an in-process `Map<fileKey, Promise>` stores the in-flight S3 download promise. The first request creates the promise and stores it. Every subsequent request for the same key finds the existing promise and awaits it. Only one S3 download happens, and all requesters get the file as soon as it's on disk.

```js
const inFlight = new Map();

async function singleflightExecute(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
```

Limitation: only works within a single process. In multi-replica ECS deployment, two replicas could both download the same file. Mitigation: use Redis distributed lock (SET NX EX) as a cross-process singleflight.

---

**Q: Walk me through the LRU eviction design.**

A: Redis sorted set `cloudvault:lru_files` scores each file key by its last-access Unix timestamp. When eviction runs, `ZRANGE ... 0 0` returns the file with the lowest (oldest) score — the least recently used file. That file is deleted from disk and removed from Redis.

The sorted set gives O(log N) operations for insert, update, and min-retrieval — much better than maintaining a linked list manually.

One non-obvious case: a file in the LRU might still be queued for upload to S3 (pending sync). Deleting it from disk before the worker uploads it loses the file permanently. The `syncTracker` Set guards against this by deferring the eviction by one hour if the file is still pending.

---

**Q: Why BullMQ instead of direct S3 upload on every POST?**

A: Direct upload would mean the client waits for the full S3 round-trip (network latency + S3 write time) before getting a response. For a 100MB file this could be 20+ seconds depending on network. With BullMQ, the flow is: write to local disk (fast, local SSD) → enqueue job (milliseconds) → return 202 Accepted. The client gets a response in under a second regardless of file size.

BullMQ also handles retry: if S3 is temporarily unavailable, the job re-runs up to 5 times with exponential backoff. Without a queue, a failed upload is lost forever and the client would need to retry.

---

**Q: How does multi-tenancy isolation work?**

A: Three layers:

1. **Auth/RBAC**: JWT contains `tenantId`. Middleware verifies the token and attaches `req.user.tenantId`. All route handlers use this value — never a user-supplied `tenantId` from the request body.

2. **Disk isolation**: All files stored at `./storage/tenants/<tenantId>/`. The `resolveTenantPath()` function enforces that the resolved absolute path must start with the tenant's root directory. If a path traversal like `../../etc/passwd` is attempted, `path.normalize` + `path.resolve` produce an absolute path that doesn't start with the tenant root, and the function throws.

3. **Redis isolation**: Every LRU key is prefixed `<tenantId>:<filePath>`. Eviction only runs per-tenant and only matches that tenant's key prefix.

MySQL rows have a `tenant_id` column and all queries include `WHERE tenant_id = ?`. SQL injection is prevented by parameterized queries.

---

**Q: How do you handle partial downloads / video streaming?**

A: HTTP Range requests (RFC 7233). The client sends `Range: bytes=500000-999999` to request a specific byte range. The server:
1. Stats the file to get `totalSizeBytes`
2. Parses the `Range` header and clamps end to `totalSizeBytes - 1`
3. Sets `Content-Range: bytes 500000-999999/5000000` and `Content-Length: 500000`
4. Responds with HTTP 206 Partial Content
5. Uses `fs.createReadStream(path, { start: 500000, end: 999999 })` — the OS only reads those bytes, not the whole file

This is how media players (HTML5 video, VLC) seek through files without downloading everything first. The `Accept-Ranges: bytes` header in the response tells the client that range requests are supported.

---

### Node.js / Backend

**Q: Why use ESM (`"type": "module"`) instead of CommonJS?**

A: ESM is the official JavaScript module standard. It enables static analysis of imports (tree-shaking), top-level `await`, and better tooling support. The AWS SDK v3 is fully tree-shakeable with ESM, so only the S3 client code is bundled rather than the entire SDK.

The main tradeoff: ESM is strict about `.js` extensions in imports (CJS allowed `require('./foo')` without extension). All imports in CloudVault include explicit `.js` extensions to comply.

---

**Q: Explain the graceful shutdown sequence.**

A: CloudVault registers `SIGTERM` and `SIGINT` handlers. When a signal arrives:
1. HTTP server stops accepting new connections (`server.close()`)
2. BullMQ worker stops picking new jobs but finishes the current one (`worker.close()`)
3. BullMQ queue connection closes (`queue.close()`)
4. MySQL pool drains (`pool.end()`)
5. Redis client quits (`redisClient.quit()`)
6. `process.exit(0)`

This matters in ECS because Fargate sends SIGTERM before replacing a task. The old task has 30 seconds to finish in-flight uploads before Fargate sends SIGKILL. Without graceful shutdown, an upload mid-way through `writeFile` could leave a corrupted file on disk.

---

**Q: What is the risk of not having `enableOfflineQueue: false` in ioredis?**

A: By default, ioredis buffers commands in memory when the Redis connection is down, and replays them when the connection recovers. For a job queue, this means: if Redis goes down for 10 minutes during a traffic spike, thousands of `queue.add()` calls buffer in process memory. When Redis recovers, ioredis floods it with all buffered commands simultaneously. Memory grows unboundedly during the outage, and the Redis recovery causes a burst of traffic that can overwhelm it again.

With `enableOfflineQueue: false`, any Redis operation fails immediately with an error when disconnected. CloudVault catches this error and falls back to inline synchronous S3 upload instead of queuing.

---

### AWS / Cloud

**Q: Why put RDS and ElastiCache in private subnets?**

A: Defense in depth. A database or cache accessible from the public internet is one leaked credential away from complete data exfiltration. Private subnets have no route to the internet gateway. Even if an attacker discovers the RDS hostname (which is a public DNS name for operational reasons), they cannot reach TCP port 3306 from outside the VPC. Security groups add a second layer: only `sgApp` can reach `sgDB` on port 3306.

---

**Q: How does the application get its secrets at runtime without hardcoding credentials?**

A: Three-layer approach:

1. **No credentials in Docker image**: The `Dockerfile` copies only source code. No `.env` file, no credentials.

2. **No credentials in ECS task definition**: Sensitive values (`JWT_SECRET`, `MYSQL_PASSWORD`, `REDIS_PASSWORD`) are absent from the task definition's environment array.

3. **Runtime injection via Secrets Manager**: At startup, `secretsService.applyAwsSecrets()` calls `GetSecretValue` using the ECS task's IAM role (no static AWS credentials needed). The returned JSON is applied to `process.env`. `resetS3Client()` reinitializes the S3 client with the new values.

The ECS task's IAM role grants `secretsmanager:GetSecretValue` for that specific secret ARN. No other AWS credential is needed.

---

**Q: What is intelligent tiering and why do you implement it yourself instead of using S3 Intelligent-Tiering storage class?**

A: S3 Intelligent-Tiering is an S3 storage class that automatically moves objects between frequent/infrequent access tiers based on access patterns. It works well for pure object storage.

CloudVault's custom tiering adds a layer S3 can't provide: awareness of the local SSD cache. CloudVault knows which files have been requested (from MySQL `last_accessed_at`) and which are currently in the local cache. Moving a file to Glacier (DEEP_ARCHIVE) means it becomes inaccessible for 12 hours while it restores. CloudVault's tiering only moves files that haven't been accessed for 30 days and are already evicted from the local SSD — reducing the chance a user is blocked waiting for a Glacier restore.

---

**Q: How would you make this production-hardened? What's missing?**

A: Genuine gaps that remain:

1. **Rate limiting on `/api/v1/auth/token`**: No protection against brute-force JWT generation. Add express-rate-limit: 10 requests/minute per IP.

2. **syncTracker persistence**: The in-memory Set is cleared on restart. Files queued before restart are unprotected from eviction until the BullMQ job runs again. Fix: persist pending-sync keys in Redis (`SADD cloudvault:pending_sync`).

3. **S3 VPC endpoint**: Traffic from ECS to S3 currently exits through the NAT Gateway (costs money, traverses public internet). A VPC Gateway Endpoint for S3 routes this traffic within AWS's network for free.

4. **EFS for shared cache**: Multiple ECS tasks have separate SSD caches. Task A may serve from cache while Task B must download from S3 for the same file. EFS (NFS) shared across all tasks would unify the cache. Tradeoff: EFS latency (~1ms) vs local SSD (<0.1ms).

5. **Distributed singleflight**: The in-process `Map` singleflight doesn't coordinate across ECS replicas. Redis lock (`SET key NX EX 30`) would provide cross-replica deduplication.

6. **Encryption at rest**: Local SSD cache files are stored unencrypted. ECS Fargate ephemeral storage encryption is available but not enabled in the task definition.

7. **Structured logging + CloudWatch Insights**: Current logs are `console.log`. Adding structured JSON (with `tenantId`, `requestId`, `durationMs`) would enable CloudWatch Insights queries like "p99 download latency by tenant over the last hour".

---

*Document generated October 2026. Covers CloudVault v1.0 as built and reviewed in this session.*
