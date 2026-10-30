# CloudVault — Complete Technical Reference

Multi-tenant hybrid-cloud storage gateway. Sits between clients and AWS S3 as an edge cache, serving files from local NVMe/SSD in ~4ms instead of ~180ms from S3. Handles multi-tenancy, LRU eviction, intelligent tiering to Glacier, and async background S3 sync via BullMQ.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Project Layout](#project-layout)
3. [File Reference](#file-reference)
4. [Configuration](#configuration)
5. [API Reference](#api-reference)
6. [Architecture & Data Flows](#architecture--data-flows)
7. [Security Model](#security-model)
8. [RBAC](#rbac)
9. [Running Tests](#running-tests)
10. [Bug Fixes Applied](#bug-fixes-applied)
11. [Suggested Improvements](#suggested-improvements)

---

## Quick Start

```bash
# Prerequisites: Node.js 20, Docker

# Start MySQL 8 + Redis
docker-compose up -d

# Copy env template and fill in values
cp .env.example .env

# Generate a secure JWT secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# Paste the output into .env as JWT_SECRET=<output>

# Start the server (port 3000 by default; use a different port if occupied)
PORT=3099 node src/server.js

# Open the UI
open http://localhost:3099
```

The server starts even without MySQL, Redis, or AWS. Those features degrade gracefully. Files can be uploaded and served from local disk only.

---

## Project Layout

```
CloudVault/
├── src/
│   ├── server.js                 Entry point. Wires all middleware, routes, and background workers.
│   ├── config/
│   │   ├── aws.js                Central AWS config. All credentials via env vars. IAM role fallback.
│   │   └── index.js              Server config (port, MySQL, Redis, storage paths). Delegates S3 to aws.js.
│   ├── routes/
│   │   ├── auth.js               POST /api/v1/auth/token, GET /api/v1/auth/me
│   │   ├── gateway.js            Upload, download, list, delete, invalidate, S3 event webhook
│   │   ├── proxy.js              Transparent REST proxy: PUT/GET/DELETE /proxy/:tenantId/*
│   │   └── health.js             GET /health, GET /health/metrics (ADMIN only)
│   ├── middleware/
│   │   ├── authMiddleware.js     JWT verification + tenant isolation + requireRole factory
│   │   └── requestLogger.js      X-Request-ID, X-Response-Time headers, request log line
│   ├── services/
│   │   ├── authService.js        JWT sign/verify, ROLES constant, hasPermission helper
│   │   ├── evictionService.js    LRU touchFile, checkAndEvict loop, invalidateFileCache
│   │   ├── metadataService.js    MySQL CRUD for files table + in-memory fallback Map
│   │   ├── queueService.js       BullMQ queue init, addS3UploadJob with timeout + fallback
│   │   ├── s3Service.js          S3Client singleton, upload, download, copy, delete, restore, objectExists
│   │   ├── secretsService.js     fetchAwsSecret, applyAwsSecrets (injects into awsConfig + resets client)
│   │   ├── singleflightService.js In-flight Map for request coalescing on S3 cache misses
│   │   └── syncTracker.js        In-process Set protecting pending-upload files from eviction
│   ├── workers/
│   │   ├── s3UploadWorker.js     BullMQ Worker that streams files from disk to S3 with retries
│   │   └── tieringWorker.js      Nightly cron: migrates stale HOT files to Glacier COLD
│   ├── db/
│   │   ├── mysql.js              mysql2 connection pool, initDB (CREATE TABLE + ALTER), query()
│   │   └── redis.js              ioredis singleton with lazyConnect
│   └── utils/
│       └── pathSanitizer.js      resolveTenantPath() — blocks path traversal via normalize + boundary check
├── public/
│   └── index.html                Dark-theme single-page UI (auth, upload, list, download, delete, invalidate)
├── tests/                        7 unit test files (no external deps needed)
├── scripts/
│   └── benchmark.js              Cache hit vs cache miss latency benchmark
├── .env.example                  All environment variables documented with empty credential fields
├── docker-compose.yml            MySQL 8 + Redis Alpine containers
├── DOCS.md                       This file
├── ARCHITECTURE_AND_IMPROVEMENTS.md  Deep-dive into all 23 improvements made
├── STREAMS_AND_ASYNC_PROCESSING.md   Node.js streams, BullMQ, and chunked download deep-dive
└── TESTING.md                    Test setup and manual test commands
```

---

## File Reference

### `src/server.js`
Entry point. Runs in this order on startup:
1. Load `src/config/aws.js` (fires AWS config warnings)
2. If `SECRETS_MANAGER_NAME` is set, call `applyAwsSecrets()` to load credentials from AWS Secrets Manager
3. Ensure `./storage/blocks/` and `./storage/tenants/` directories exist
4. Call `initDB()` — create MySQL tables if not present
5. Call `getRedisClient()` — initialize ioredis with lazy connect
6. Start eviction watcher (30-second interval)
7. Start tiering cron (24-hour interval)
8. Start BullMQ S3 upload worker (5 concurrent)
9. Listen on `config.port`

If the port is already in use, logs a clear `EADDRINUSE` message and exits with code 1.

---

### `src/config/aws.js`
Single source of truth for all AWS configuration. Reads everything from environment variables. Never hardcodes credentials.

Key exports:
- `awsConfig` — live object with all AWS settings. The `secretsService` writes directly into this object at runtime after loading from Secrets Manager.
- `resolveCredentials()` — returns `{ accessKeyId, secretAccessKey, sessionToken }` if keys are set, or `undefined` to let the SDK use IAM role.
- `validateAwsConfig()` — logs warnings for missing config at startup. Never throws.

---

### `src/config/index.js`
Builds the server config object. The `s3.*` properties are JavaScript getters that delegate live to `awsConfig`, so there are no stale copies.

Default values: port 3000, MySQL on localhost:3306, Redis on localhost:6379, 100MB cache limit, no upload size limit (0 = unlimited).

---

### `src/routes/auth.js`
- `POST /api/v1/auth/token` — Issues JWT. In production, set `TOKEN_API_KEY` env var to gate this endpoint with an `x-api-key` header check.
- `GET /api/v1/auth/me` — Returns decoded JWT payload. Useful for client-side role checking.

---

### `src/routes/gateway.js`
Main API surface. All routes require JWT + `x-tenant-id` header.

| Route | Method | Role | Description |
|---|---|---|---|
| `/upload` | POST | DEVELOPER+ | Multipart or raw stream upload. Saves to disk, writes MySQL metadata, queues S3 sync via BullMQ. |
| `/download` | GET | VIEWER+ | Cache-hit path: streams from disk. Cache-miss: singleflight fetch from S3, cache locally, then stream. Glacier: returns 202. |
| `/files` | GET | VIEWER+ | Lists all files for the tenant (MySQL + in-memory fallback). |
| `/files` | DELETE | ADMIN | Deletes disk file, MySQL record, Redis LRU entry. |
| `/invalidate` | POST | ADMIN | Purges local disk cache for a file. Next download re-fetches from S3. |
| `/s3-event` | POST | ADMIN | AWS S3 event notification webhook. Invalidates cache on ObjectCreated/Removed. |

---

### `src/routes/proxy.js`
Transparent pass-through proxy. URL-based routing instead of query params.

| Route | Method | Role | Description |
|---|---|---|---|
| `/proxy/:tenantId/*` | PUT/POST | DEVELOPER+ | Upload via REST path |
| `/proxy/:tenantId/*` | GET | VIEWER+ | Download with Range support. Streams from disk (createReadStream). |
| `/proxy/:tenantId/*` | DELETE | ADMIN | Delete from disk + MySQL + Redis |

Response headers added: `X-Cache-Status` (CACHE_HIT / CACHE_MISS_S3_FETCH), `X-Storage-Proxy`, `X-Storage-Tier`, `X-Request-ID`, `X-Response-Time`.

---

### `src/routes/health.js`
- `GET /health` — Public. Returns `{ status: "online", service, timestamp }`.
- `GET /health/metrics` — ADMIN JWT required. Returns MySQL/Redis connection status and local disk usage.

---

### `src/middleware/authMiddleware.js`
`authenticateTenant(req, res, next)`:
1. Extracts JWT from `Authorization: Bearer <token>` or `x-api-key` header.
2. Verifies signature via `authService.verifyAccessToken()`.
3. Enforces tenant isolation: if `x-tenant-id` header doesn't match token's `tenantId`, rejects unless role is ADMIN.
4. Sets `req.user = { tenantId, role, userId }`.

`requireRole(allowedRoles)`:
- Returns middleware that checks `req.user.role`.
- ADMIN always passes regardless of which roles are specified.

`DISABLE_AUTH=true` bypasses JWT checks (dev only). Defaults to DEVELOPER role with a loud warning.

---

### `src/middleware/requestLogger.js`
Overrides `res.end` to:
- Inject `X-Response-Time` header (skipped if headers already sent — prevents crash on streaming responses).
- Log `METHOD URL -> Status Xms [ReqID: xxxxxxxx]`.

Injects `X-Request-ID` (UUID v4) on every request.

---

### `src/services/authService.js`
- `generateAccessToken({ tenantId, role, userId })` — Signs a JWT with 24h expiry.
- `verifyAccessToken(token)` — Verifies and decodes JWT.
- `hasPermission(role, operation)` — Returns true if role can perform the operation (`read`, `write`, `delete`).
- `ROLES` — `{ ADMIN: 'ADMIN', DEVELOPER: 'DEVELOPER', VIEWER: 'VIEWER' }`.

JWT secret from `JWT_SECRET` env var. If not set, uses an insecure default and logs a loud warning.

---

### `src/services/evictionService.js`
`touchFile(redis, fileKey)` — Updates the Redis ZSET score for a file to `Date.now()`.

`checkAndEvict(redis, tenantsDir, maxCacheSizeBytes)`:
1. Walk `./storage/tenants/` and sum file sizes.
2. If under limit, return immediately.
3. While over limit: query Redis for lowest-scored key (`ZRANGE 0 0`).
4. Skip keys pending S3 sync — defer them by 1 hour in the ZSET.
5. Use `resolveTenantPath()` to safely resolve disk path.
6. Delete disk file, remove from Redis ZSET, subtract size.
7. Cap at 500 iterations to prevent infinite loop if all keys are pending sync.

`invalidateFileCache(tenantId, filePath)` — Deletes the local disk file. Used by the S3 event webhook and the invalidate API.

`startEvictionWatcher(redis, options)` — Runs `checkAndEvict` on a 30-second interval.

---

### `src/services/metadataService.js`
MySQL-backed file metadata with an in-memory `Map` fallback for when MySQL is unavailable.

Functions: `createFileRecord`, `getFileMetadata`, `touchFileAccess`, `updateFileTier`, `listTenantFiles`, `deleteFileRecord`.

The in-memory Map is capped at 5000 entries (FIFO eviction). MySQL is always tried first; in-memory is the fallback.

---

### `src/services/queueService.js`
`getS3UploadQueue()` — Lazily initializes a BullMQ Queue named `s3-upload-queue`.
- 5 retries with exponential backoff (2s, 4s, 8s, 16s, 32s).
- `enableOfflineQueue: false` — fails immediately instead of buffering when Redis is down.
- `connectTimeout: 5000ms`.

`addS3UploadJob(payload)`:
- Adds job to BullMQ with a 4-second timeout (prevents hanging if Redis is slow).
- Calls `markPendingSync()` after successful enqueue.
- Returns `{ status: 'FALLBACK_INLINE' }` if queue is unavailable — caller does inline S3 upload.

---

### `src/services/s3Service.js`
Singleton S3Client via `getS3Client()`. Rebuilt after `resetS3Client()` is called (used after Secrets Manager injects new credentials).

Functions:
- `uploadFileToS3(s3Key, source, bucketName)` — Multipart upload via `@aws-sdk/lib-storage`. 4 parallel parts, 5MB minimum part size. `source` can be a file path string or a readable stream.
- `downloadFileFromS3(s3Key, bucketName)` — Downloads and returns a `Buffer`.
- `objectExists(s3Key, bucketName)` — HeadObject check, returns boolean.
- `copyObjectBetweenBuckets(src, dest, key, storageClass)` — Used for Hot→Cold tiering.
- `deleteObjectFromBucket(bucket, key)` — Hard delete from S3.
- `restoreGlacierObject(key, bucket, restoreDays=7)` — Initiates Glacier restore (3–5h Standard tier). Gracefully handles `RestoreAlreadyInProgress`.
- `getTenantBucket(tenantId, tier)` — Returns bucket name. Throws informative error if bucket env var is not set. Supports per-tenant buckets via `DYNAMIC_TENANT_BUCKETS=true`.

---

### `src/services/secretsService.js`
`fetchAwsSecret(secretName, region)` — Fetches a JSON secret from AWS Secrets Manager. Uses the SDK default credential chain (IAM role), no explicit keys.

`applyAwsSecrets(secretName, region)`:
1. Fetches the secret.
2. Injects `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `S3_BUCKET_NAME`, `COLD_BUCKET` directly into the live `awsConfig` object.
3. Calls `resetS3Client()` so the next S3 operation uses the new credentials.
4. Returns the full secret object so the caller can apply `MYSQL_PASSWORD` and `REDIS_PASSWORD`.

---

### `src/services/singleflightService.js`
In-memory `Map<key, Promise>` for request coalescing. When N concurrent requests arrive for the same missing file, only the first triggers an S3 download. The rest await the same Promise. The Map entry is deleted in a `finally` block.

---

### `src/services/syncTracker.js`
In-process `Set<string>` of file keys currently in the BullMQ S3 upload queue. Prevents eviction from deleting a file that hasn't been synced to S3 yet.

- `markPendingSync(key)` — called when job is enqueued
- `clearPendingSync(key)` — called when job completes or exhausts all retries
- `isPendingSync(key)` — checked by eviction before deleting

Note: this Set is in-memory. It is empty after a process restart, so pending jobs that survive in Redis/BullMQ across a restart won't be guarded until they complete or the process re-enqueues them.

---

### `src/workers/s3UploadWorker.js`
BullMQ Worker processing jobs from `s3-upload-queue`. Concurrency defaults to 5.

For each job: streams the local disk file to S3 via `uploadFileToS3`. On `completed` event: calls `clearPendingSync`. On `failed` event after all retries: calls `clearPendingSync` to allow eviction.

---

### `src/workers/tieringWorker.js`
`runIntelligentTiering(inactivityDays)`:
1. Bail early if `HOT_BUCKET` or `COLD_BUCKET` are not set.
2. Query MySQL for files with `current_tier = 'HOT'` and `last_accessed_at` older than N days.
3. For each file (in series): copy to Cold bucket → update MySQL (`current_tier = 'COLD'`) → delete from Hot bucket.
   - MySQL is updated BEFORE deletion. If deletion fails, the record stays COLD and won't be re-tiered next run.
4. Per-file errors are caught and logged; one failure doesn't stop the rest.

`startTieringCron(intervalMs=86400000)` — Runs the scan on an interval (default: 24 hours).

---

### `src/db/mysql.js`
`mysql2/promise` connection pool (10 connections). `initDB()` creates the `files` table if not present and runs three safe `ALTER TABLE ADD COLUMN` migrations (ignoring `errno 1060` duplicate-column errors). `query(sql, params)` wraps `pool.execute()`.

---

### `src/db/redis.js`
`ioredis` singleton with `lazyConnect: true` (doesn't connect until first command). `maxRetriesPerRequest: 3`. Passes `REDIS_PASSWORD` from config. Error events are logged without crashing.

---

### `src/utils/pathSanitizer.js`
`resolveTenantPath(tenantId, userRequestedPath, baseStorageDir?)`:
1. `path.normalize(userRequestedPath)` — collapses `../` sequences.
2. `path.resolve(baseTenantFolder, normalizedPath)` — gets absolute path.
3. Verifies the resolved path starts with `./storage/tenants/<tenantId>/`.
4. If it escapes the tenant root, throws `SecurityError` (HTTP 403).

This prevents path traversal attacks like `../../etc/passwd` or `../other-tenant/secret.pdf`.

---

## Configuration

All environment variables — copy `.env.example` to `.env` and fill in.

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `DISABLE_AUTH` | — | Set `true` to bypass JWT in dev. Never in production. |

### Security

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | insecure default | Required in production. Generate: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `TOKEN_API_KEY` | — | If set, `POST /auth/token` requires `x-api-key: <value>` |

### MySQL

| Variable | Default | Description |
|---|---|---|
| `MYSQL_HOST` | `localhost` | |
| `MYSQL_PORT` | `3306` | |
| `MYSQL_USER` | `root` | |
| `MYSQL_PASSWORD` | *(empty)* | |
| `MYSQL_DATABASE` | `cloudvault` | |

### Redis

| Variable | Default | Description |
|---|---|---|
| `REDIS_HOST` | `localhost` | |
| `REDIS_PORT` | `6379` | |
| `REDIS_PASSWORD` | — | Leave blank for no-auth Redis |

### Storage

| Variable | Default | Description |
|---|---|---|
| `TENANTS_STORAGE_DIR` | `./storage/tenants` | Local SSD cache root |
| `MAX_CACHE_SIZE_BYTES` | `104857600` (100MB) | LRU eviction threshold |
| `MAX_UPLOAD_SIZE_BYTES` | `0` (unlimited) | Upload size limit; 0 = no limit |

### AWS Core

| Variable | Default | Description |
|---|---|---|
| `AWS_REGION` | `us-east-1` | |
| `AWS_ACCESS_KEY_ID` | — | Leave blank to use IAM role |
| `AWS_SECRET_ACCESS_KEY` | — | Leave blank to use IAM role |
| `AWS_SESSION_TOKEN` | — | For STS temporary credentials only |
| `S3_ENDPOINT` | — | LocalStack/MinIO endpoint for local dev |

### S3 Buckets

| Variable | Default | Description |
|---|---|---|
| `HOT_BUCKET` | — | S3 Standard bucket for active files |
| `COLD_BUCKET` | — | S3 Glacier bucket for archived files |
| `TIERING_INACTIVITY_DAYS` | `30` | Days before a file is moved to Glacier |
| `DYNAMIC_TENANT_BUCKETS` | — | Set `true` to route per-tenant to `<HOT_BUCKET>-<tenantId>` |

### Secrets Manager

| Variable | Default | Description |
|---|---|---|
| `SECRETS_MANAGER_NAME` | — | AWS Secrets Manager secret name or ARN |

### SNS / SQS

| Variable | Default | Description |
|---|---|---|
| `AWS_SQS_QUEUE_URL` | — | SQS queue URL for S3 event notifications |
| `AWS_SNS_TOPIC_ARN` | — | SNS topic ARN |

### Worker

| Variable | Default | Description |
|---|---|---|
| `QUEUE_CONCURRENCY` | `5` | Parallel S3 upload jobs in BullMQ worker |

---

## API Reference

### Authentication

All gateway and proxy endpoints require:
- `Authorization: Bearer <jwt>` header
- `x-tenant-id: <tenantId>` header

Get a JWT:
```bash
curl -X POST http://localhost:3099/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"tenantId": "tenant-alex", "role": "ADMIN"}'
```

Response:
```json
{ "token": "<jwt>", "tenantId": "tenant-alex", "role": "ADMIN", "expiresIn": "24h" }
```

---

### Gateway API

#### Upload — `POST /api/v1/gateway/upload`

Multipart (browser):
```bash
curl -X POST http://localhost:3099/api/v1/gateway/upload \
  -H "Authorization: Bearer <token>" \
  -H "x-tenant-id: tenant-alex" \
  -F "file=@./myfile.pdf" \
  -F "filePath=docs/myfile.pdf"
```

Raw stream:
```bash
curl -X POST "http://localhost:3099/api/v1/gateway/upload?filePath=docs/myfile.pdf" \
  -H "Authorization: Bearer <token>" \
  -H "x-tenant-id: tenant-alex" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @./myfile.pdf
```

Response `201`:
```json
{
  "message": "File uploaded successfully",
  "file": { "id": 1, "tenantId": "tenant-alex", "filePath": "docs/myfile.pdf", "sizeBytes": 204800, "currentTier": "HOT" }
}
```

#### Download — `GET /api/v1/gateway/download?filePath=<path>`

```bash
curl -O -J "http://localhost:3099/api/v1/gateway/download?filePath=docs/myfile.pdf" \
  -H "Authorization: Bearer <token>" \
  -H "x-tenant-id: tenant-alex"
```

Range download (HTTP 206):
```bash
curl -H "Range: bytes=0-1023" "http://localhost:3099/api/v1/gateway/download?filePath=video.mp4" \
  -H "Authorization: Bearer <token>" -H "x-tenant-id: tenant-alex"
```

Glacier response `202`:
```json
{ "status": "archived", "message": "File is being restored from Glacier cold storage. Available in local cache within 3-5 hours." }
```

#### List Files — `GET /api/v1/gateway/files`

```bash
curl http://localhost:3099/api/v1/gateway/files \
  -H "Authorization: Bearer <token>" -H "x-tenant-id: tenant-alex"
```

Response:
```json
{
  "files": [
    { "filePath": "docs/myfile.pdf", "fileName": "myfile.pdf", "sizeBytes": 204800, "currentTier": "HOT", "lastAccessedAt": "2026-10-30T08:00:00Z", "accessCount": 12 }
  ]
}
```

#### Delete File — `DELETE /api/v1/gateway/files?filePath=<path>`

ADMIN only. Removes disk file + MySQL record + Redis LRU entry.

```bash
curl -X DELETE "http://localhost:3099/api/v1/gateway/files?filePath=docs/myfile.pdf" \
  -H "Authorization: Bearer <token>" -H "x-tenant-id: tenant-alex"
```

#### Invalidate Cache — `POST /api/v1/gateway/invalidate?filePath=<path>`

ADMIN only. Purges local disk copy. Next download re-fetches from S3.

```bash
curl -X POST "http://localhost:3099/api/v1/gateway/invalidate?filePath=docs/myfile.pdf" \
  -H "Authorization: Bearer <token>" -H "x-tenant-id: tenant-alex"
```

#### S3 Event Webhook — `POST /api/v1/gateway/s3-event`

ADMIN only. Configure this URL in S3 bucket Event Notifications. Automatically invalidates local cache when S3 objects are created or deleted.

---

### Proxy API

```bash
# Upload
curl -X PUT "http://localhost:3099/proxy/tenant-alex/docs/myfile.pdf" \
  -H "Authorization: Bearer <token>" \
  --data-binary @./myfile.pdf

# Download (with streaming headers)
curl "http://localhost:3099/proxy/tenant-alex/docs/myfile.pdf" \
  -H "Authorization: Bearer <token>"

# Delete
curl -X DELETE "http://localhost:3099/proxy/tenant-alex/docs/myfile.pdf" \
  -H "Authorization: Bearer <token>"
```

---

### Health

```bash
# Public
curl http://localhost:3099/health

# Metrics (ADMIN JWT required)
curl http://localhost:3099/health/metrics \
  -H "Authorization: Bearer <token>" -H "x-tenant-id: tenant-alex"
```

---

## Architecture & Data Flows

### Upload Flow

```
Client POST /upload
  │
  ├─ 1. JWT auth check + tenant isolation (authMiddleware)
  ├─ 2. DEVELOPER or ADMIN role required (requireRole)
  ├─ 3. Path traversal check (resolveTenantPath)
  ├─ 4. Stream body to disk: ./storage/tenants/<tenantId>/<filePath>
  ├─ 5. MySQL INSERT (files table) + in-memory fallback Map
  ├─ 6. Redis ZADD cloudvault:lru_files <tenantId>:<filePath> score=now
  ├─ 7. BullMQ enqueue (s3-upload-queue), markPendingSync()
  └─ 8. Return HTTP 201 to client immediately
       │
       └─ [Background] BullMQ Worker picks up job
            ├─ Stream file to S3 Hot Bucket (multipart, 5MB parts)
            └─ clearPendingSync() on success or final failure
```

### Download Flow

```
Client GET /download?filePath=X
  │
  ├─ 1. JWT auth (VIEWER, DEVELOPER, or ADMIN)
  ├─ 2. MySQL lookup → get s3Key + currentTier
  ├─ 3. touchFileAccess (updates last_accessed_at + access_count)
  │
  ├─ Local disk file exists?
  │    YES → Redis ZADD (touch LRU), stream file from disk (~4ms)
  │
  └─ NO (cache miss)
       ├─ tier = COLD?
       │    YES → trigger Glacier restore, return HTTP 202 (3-5h wait)
       │
       └─ tier = HOT
            ├─ Singleflight check: already fetching this key?
            │    YES → join in-flight Promise (no extra S3 call)
            │    NO  → fetch from S3, write to disk, Redis ZADD
            └─ Stream file to client
```

### LRU Eviction Flow

```
Every 30 seconds:
  ├─ Walk ./storage/tenants/, sum file sizes
  ├─ Under MAX_CACHE_SIZE_BYTES? → done
  └─ Over limit:
       loop (max 500 iterations):
         ├─ ZRANGE cloudvault:lru_files 0 0 → get lowest-score key
         ├─ isPendingSync? → defer 1 hour in ZSET, continue
         ├─ resolveTenantPath(tenantId, filePath) → safe disk path
         ├─ unlink disk file
         ├─ ZREM cloudvault:lru_files key
         └─ subtract size; if under limit → stop
```

### Intelligent Tiering Flow

```
Every 24 hours (nightly):
  ├─ Bail early if HOT_BUCKET or COLD_BUCKET not set
  ├─ MySQL: SELECT files WHERE tier=HOT AND last_accessed_at < NOW() - INTERVAL N DAY
  └─ For each stale file (in series):
       ├─ S3 CopyObject: Hot → Cold (StorageClass: GLACIER)
       ├─ MySQL UPDATE current_tier = 'COLD'   ← committed BEFORE deletion
       └─ S3 DeleteObject from Hot bucket
```

### Storage Layout

```
./storage/
  tenants/
    tenant-alex/
      docs/
        report.pdf
        invoice.pdf
      images/
        logo.png
    tenant-bob/
      exports/
        data.csv
```

Each tenant is strictly isolated. `resolveTenantPath("tenant-alex", "../../tenant-bob/secret")` throws `SecurityError(403)`.

### S3 Key Format

```
tenants/<tenantId>/<filePath>
```
Example: `tenants/tenant-alex/docs/report.pdf`

---

## Security Model

| Threat | Where defended | Mechanism |
|---|---|---|
| Path traversal (`../../`) | `pathSanitizer.js` | `normalize` + boundary check vs tenant root |
| Cross-tenant data access | `authMiddleware.js` + MySQL | JWT tenant claim + `WHERE tenant_id = ?` |
| Unauthenticated access | `authMiddleware.js` | JWT required on all gateway/proxy routes |
| Privilege escalation | `authMiddleware.js` requireRole | VIEWER cannot write/delete, DEVELOPER cannot delete/invalidate |
| S3 credential exposure | `s3Service.js` | AWS keys stay server-side; buckets are private |
| Thundering Herd on S3 | `singleflightService.js` | In-flight Map coalesces concurrent S3 fetches to 1 |
| Upload size abuse | `gateway.js`, `proxy.js` | `MAX_UPLOAD_SIZE_BYTES` checked on both content-length and busboy limits |
| Metrics exposure | `health.js` | `requireRole('ADMIN')` on `/health/metrics` |
| S3 event webhook abuse | `gateway.js` | `requireRole('ADMIN')` on `/s3-event` |
| Evicting pending uploads | `syncTracker.js` | `isPendingSync` guard in eviction loop |

---

## RBAC

| Operation | VIEWER | DEVELOPER | ADMIN |
|---|---|---|---|
| List files (`GET /files`) | Yes | Yes | Yes |
| Download file | Yes | Yes | Yes |
| Upload file | No | Yes | Yes |
| Delete file | No | No | Yes |
| Invalidate cache | No | No | Yes |
| View metrics (`/health/metrics`) | No | No | Yes |
| S3 event webhook | No | No | Yes |

ADMIN implicitly passes all `requireRole()` checks regardless of which roles are listed.

---

## Running Tests

```bash
npm test
```

Seven test suites:

| File | What it tests |
|---|---|
| `tests/pathSanitizer.test.js` | Traversal blocked, valid paths accepted, edge cases |
| `tests/singleflight.test.js` | Concurrent requests coalesced, no duplicate S3 calls |
| `tests/eviction.test.js` | LRU score update, size calculation |
| `tests/proxy.test.js` | Proxy route responses, auth enforcement |
| `tests/health.test.js` | Health endpoint response shape |
| `tests/queue.test.js` | BullMQ enqueue with timeout, fallback when Redis down |
| `tests/auth.test.js` | JWT sign/verify, RBAC permission checks |

All tests run without Docker. Redis/MySQL-dependent tests degrade gracefully when those services are unavailable.

---

## Bug Fixes Applied

This section documents all bugs fixed from the original codebase through two review passes.

### Pass 1 (23 issues)

| # | File | Issue | Fix |
|---|---|---|---|
| 1 | `proxy.js` | `hasPermission` imported from `authMiddleware` which never exported it → startup crash | Changed import to `authService.hasPermission` |
| 2 | `requestLogger.js` | `res.setHeader('X-Response-Time')` called after headers sent on streaming response → `ERR_HTTP_HEADERS_SENT` crash | Added `if (!res.headersSent)` guard |
| 3 | `gateway.js` | RFC 7233 Range `end` not clamped to `totalSizeBytes - 1` | Fixed: `Math.min(parseInt(match[2]), totalSizeBytes - 1)` |
| 4 | `gateway.js` | `res` variable shadowed in `addS3UploadJob().then()` callback | Renamed inner variable to `jobResult` |
| 5 | `proxy.js` | Same `res` shadowing in upload callback | Same fix |
| 6 | `gateway.js` | No upload size limit on raw stream or multipart | Added content-length check + `busboyOpts.limits.fileSize` |
| 7 | `proxy.js` | No upload size limit | Same fix |
| 8 | `evictionService.js` `invalidateFileCache` | `path.join` used instead of `resolveTenantPath` | Replaced with `resolveTenantPath()`, catch `SecurityError` |
| 9 | `evictionService.js` | No syncTracker guard — eviction could delete files mid-upload | Added `isPendingSync` check with 1-hour defer |
| 10 | `metadataService.js` | In-memory Map unbounded — could grow to millions of entries | Added FIFO cap at 5000 entries |
| 11 | `queueService.js` | Duplicate jobId if same file uploaded twice → BullMQ deduplicate bug | Appended `Date.now()` to jobId |
| 12 | `queueService.js` | `queue.add()` hangs indefinitely when Redis is slow | Added `Promise.race` with 4-second timeout |
| 13 | `queueService.js` | No `enableOfflineQueue: false` — commands buffered forever | Added `enableOfflineQueue: false, connectTimeout: 5000` |
| 14 | `s3UploadWorker.js` | No `clearPendingSync` on job completion | Added `clearPendingSync` in `completed` and `failed` events |
| 15 | `tieringWorker.js` | Migration order: copy → delete → MySQL update. If MySQL fails, file is deleted from Hot but metadata still says HOT → data loss | Fixed order: copy → MySQL update → delete |
| 16 | `authMiddleware.js` | `DISABLE_AUTH` fallback defaulted to ADMIN role | Changed to DEVELOPER with loud warning |
| 17 | `authService.js` | Hardcoded JWT secret fallback was silent | Added loud `console.warn` for insecure default |
| 18 | `health.js` | `/health/metrics` was unauthenticated — leaked infrastructure info | Added `requireRole('ADMIN')` |
| 19 | `gateway.js` `/s3-event` | S3 event webhook was unauthenticated | Added `authenticateTenant, requireRole('ADMIN')` |
| 20 | `auth.js` | No protection on token issuance endpoint | Added optional `TOKEN_API_KEY` gate |
| 21 | `mysql.js` | ALTER TABLE catch swallowed all errors | Changed to only ignore `errno 1060` (duplicate column) |
| 22 | `server.js` (root) | Dead CJS file referencing non-existent modules — confusing | Deleted |
| 23 | `tests/queue.test.js` | Test hung indefinitely — ioredis keepalive prevented process exit | Added `process.exit(0)` after `queue.close()` |

### Pass 2 (5 bugs)

| # | File | Issue | Fix |
|---|---|---|---|
| 24 | `redis.js` | `config.redis.password` defined but never passed to ioredis — Redis auth always fails | Added `password: config.redis.password \|\| undefined` |
| 25 | `queueService.js` | BullMQ Redis connection missing password | Same fix |
| 26 | `s3UploadWorker.js` | BullMQ worker Redis connection missing password | Same fix |
| 27 | `evictionService.js` `checkAndEvict` | No iteration cap — infinite loop if all Redis keys are pending sync | Added `MAX_EVICTION_ITERATIONS = 500` guard |
| 28 | `tieringWorker.js` | No early exit when `HOT_BUCKET` or `COLD_BUCKET` null — threw on every file | Added upfront null check with warning and early return |

---

## Suggested Improvements

These are not bugs but meaningful improvements for production readiness:

### High Priority

**1. Rate limiting on `/api/v1/auth/token`**

Without rate limiting, anyone who can reach the server can generate unlimited JWTs. Add `express-rate-limit`:

```bash
npm install express-rate-limit
```

```js
// src/routes/auth.js
import rateLimit from 'express-rate-limit';

const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,
  standardHeaders: true,
  message: { error: 'Too many token requests. Try again in 15 minutes.' },
});

router.post('/token', tokenLimiter, (req, res) => { ... });
```

**2. Stream large file downloads in `gateway.js`**

`gateway.js` download handler currently buffers the full file into memory (`readFile` + `fileBuffer.subarray`). For files > 100MB this causes high heap usage. `proxy.js` already uses `createReadStream().pipe(res)` correctly — the same pattern should be applied to `gateway.js`.

The current gateway.js approach does have one benefit: it supports Range requests with a simple `subarray`. The fix is to calculate the range first, then use `createReadStream({ start, end })` like proxy.js does.

**3. `syncTracker.js` — lost state on process restart**

When the server restarts, `pendingSyncKeys` is an empty Set. Any BullMQ jobs that were enqueued before the restart won't be guarded from eviction. This is unlikely to cause data loss (BullMQ retries mean the job will still run), but it's a gap.

Fix: On startup, read all active BullMQ jobs from Redis and call `markPendingSync` for each.

```js
// In startServer() after startS3UploadWorker():
const queue = getS3UploadQueue();
if (queue) {
  const activeJobs = await queue.getActive();
  const waitingJobs = await queue.getWaiting();
  [...activeJobs, ...waitingJobs].forEach(job => {
    if (job.data?.tenantId && job.data?.filePath) {
      markPendingSync(`${job.data.tenantId}:${job.data.filePath}`);
    }
  });
}
```

### Medium Priority

**4. Per-tenant storage quota**

Currently all tenants share the global `MAX_CACHE_SIZE_BYTES` limit. Adding per-tenant quotas would prevent one tenant from consuming all cache space. This would require a `quotas` table in MySQL or a per-tenant config file.

**5. Retry on Glacier restore — poll for completion**

`restoreGlacierObject` initiates the restore and returns immediately. The client gets HTTP 202. There is no mechanism to notify the client when the file is ready (3–5 hours later). Adding an SQS or SNS notification when the restore completes would improve UX significantly.

**6. S3 key conflict on file overwrite**

When a file is re-uploaded with the same path, `createFileRecord` does an `ON DUPLICATE KEY UPDATE` which correctly updates MySQL. However, there is no check whether the old file is still pending S3 sync. If the old version is in BullMQ but not yet uploaded, and the new version is also queued, both jobs will upload to the same `s3Key`. The second job wins since S3 is eventually consistent, but the BullMQ job for the old version wastes bandwidth.

**7. Structured JSON logging**

Current logging uses `console.log/warn/error` with free-form strings. In production, structured JSON logs (e.g. using `pino`) make log aggregation much easier:

```bash
npm install pino pino-http
```

**8. Health check exposes error messages to public**

`GET /health/metrics` returns `err.message` for MySQL/Redis errors. While this endpoint requires ADMIN JWT, consider whether error details should be in the response or just logged server-side.

### Low Priority

**9. SQS polling service**

`sqsService.js` (legacy CJS, not connected to the active server) would allow CloudVault to receive S3 event notifications via SQS long-polling instead of requiring S3 to call the webhook directly. This is more reliable and avoids the need for a public-facing webhook URL. Migration to ESM and integration with `server.js` is straightforward but wasn't part of the original scope.

**10. Helmet CSP configuration**

`helmet()` is used with defaults. For a production deployment serving the static UI, a proper `Content-Security-Policy` should be configured to prevent XSS:

```js
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // remove unsafe-inline after extracting JS to .js file
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));
```
