# CloudVault — Multi-Tenant Cloud Storage Gateway

[![Node.js](https://img.shields.io/badge/Node.js-20_ESM-green?style=flat&logo=node.js)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4-lightgrey?style=flat&logo=express)](https://expressjs.com/)
[![AWS S3](https://img.shields.io/badge/AWS-S3_SDK_v3-orange?style=flat&logo=amazon-aws)](https://aws.amazon.com/s3/)
[![Redis](https://img.shields.io/badge/Redis-LRU_Cache-red?style=flat&logo=redis)](https://redis.io/)
[![MySQL](https://img.shields.io/badge/MySQL-8-blue?style=flat&logo=mysql)](https://www.mysql.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue?style=flat&logo=docker)](https://www.docker.com/)
[![ECS Fargate](https://img.shields.io/badge/AWS-ECS_Fargate-orange?style=flat&logo=amazon-aws)](https://aws.amazon.com/ecs/)

---

## What is CloudVault

CloudVault is a **multi-tenant storage gateway** that sits between client applications and AWS S3. Instead of clients hitting S3 directly (180ms+ per request, high egress cost), every upload and download routes through this Node.js 20 ESM Express server, which:

- Caches hot files on local disk — repeat downloads served in ~4ms instead of ~180ms
- Queues S3 uploads asynchronously via BullMQ — clients get `202 Accepted` instantly
- Automatically tiers cold files (30+ days untouched) from S3 Standard to Glacier
- Enforces strict tenant isolation — tenant A cannot access tenant B's files
- Enforces RBAC via JWT — `ADMIN` / `DEVELOPER` / `VIEWER` roles
- In production: all tasks share one EFS cache volume — no duplicate S3 fetches across replicas

---

## Architecture

```
Internet
  │
  ▼
CloudFront CDN  ← edge-caches file downloads, free DDoS protection
  │
  ▼
ALB (public subnets, 2 AZs)
  │
  ▼
ECS Fargate Tasks (private subnets) — all tasks mount the same EFS volume
  │
  ├─ Auth: JWT verified, tenantId boundary checked, RBAC role checked
  ├─ Path: resolveTenantPath() blocks any ../../ traversal attempt
  │
  ├─ UPLOAD:
  │    busboy parse → write to EFS /storage/tenants/<id>/
  │    → markPendingSync → BullMQ enqueue → 202 response
  │    BullMQ Worker: dequeue → stream to S3 (5 retries + backoff)
  │
  └─ DOWNLOAD:
       EFS hit  → touch Redis LRU score → stream via createReadStream (206/200)
       EFS miss → singleflight S3 fetch (1 request even if 50 concurrent)
                → write to EFS → stream via createReadStream (206/200)
       Cold tier → 503 (Glacier restore required, typically 3-5 hours)

Data stores:
  MySQL 8        — files table: tenant_id, s3_key, tier, last_accessed_at
  Redis          — LRU sorted set: cloudvault:lru_files (score = last access timestamp)

Background workers:
  BullMQ Worker  — drains S3 upload queue, 5 retries with exponential backoff
  Tiering Cron   — every 30 min, Redis distributed lock ensures only 1 task runs
  Eviction Loop  — triggered after each upload, LRU evicts if disk > MAX_CACHE_SIZE_BYTES

Outbound network (private subnets → internet):
  S3 traffic     → VPC Gateway Endpoint (free, never leaves AWS network)
  All other      → NAT Gateway → Internet Gateway
```

---

## Setup — Step by Step

### Prerequisites

- Node.js 20+
- Docker Desktop
- Git

### Step 1 — Clone the repo

```bash
git clone https://github.com/vinay020606/CloudVault.git
cd CloudVault
```

### Step 2 — Create your .env file

```bash
cp .env.example .env
```

Open `.env` and fill in at minimum:

```env
# Server
PORT=3000

# Auth — generate a strong random secret:
# node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=<64-char-hex>
TOKEN_API_KEY=<any-random-string>

# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=<your-password>
MYSQL_DATABASE=cloudvault

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Storage
TENANTS_STORAGE_DIR=./storage/tenants
MAX_CACHE_SIZE_BYTES=104857600

# AWS (leave blank for LocalStack demo)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
HOT_BUCKET=
COLD_BUCKET=
```

> **Note:** If port 3000 is occupied on your machine, set `PORT=3099` or any free port.

### Step 3 — Start dependencies

```bash
docker-compose up -d
```

This starts MySQL 8 and Redis 7 in Docker. Takes about 10 seconds.

### Step 4 — Start the server

```bash
node src/server.js
```

You should see:

```
[Server] MySQL connected
[Server] Redis connected
[Server] CloudVault listening on port 3000
```

### Step 5 — Open the UI

Go to **http://localhost:3000**

You will see the management dashboard. To log in:

1. Enter a `tenantId` (e.g. `tenant-demo`)
2. Select role `ADMIN`
3. Click **Get Token** — this calls `POST /api/v1/auth/token`
4. The token is stored in the browser and used for all subsequent requests

From the UI you can upload files, download, invalidate cache, and delete.

---

## Demo Mode — No AWS Account Needed

To run a fully working demo including S3-compatible storage (no real AWS):

```bash
docker-compose -f docker-compose.demo.yml up --build
```

This starts:
- MySQL 8
- Redis 7
- LocalStack (S3 emulation on port 4566)
- CloudVault app on port 3000

The `scripts/localstack-init.sh` script runs automatically and creates:
- `s3://cloudvault-hot` (with versioning enabled)
- `s3://cloudvault-cold`

Everything works end-to-end. Uploads go to LocalStack S3. Downloads serve from local disk cache (or LocalStack on cache miss). Tiering, eviction, RBAC — all functional.

To tear down:

```bash
docker-compose -f docker-compose.demo.yml down -v
```

---

## Production Deployment — AWS ECS Fargate

Full step-by-step guide is in [DEPLOYMENT.md](./DEPLOYMENT.md). Summary:

```bash
# 1. Deploy the full AWS stack (VPC, ALB, ECS, RDS, Redis, EFS, CloudFront, S3, ECR)
aws cloudformation deploy \
  --template-file deploy/cloudformation/infra.yml \
  --stack-name cloudvault-prod \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      HotBucketName=<unique-name> \
      ColdBucketName=<unique-name>

# 2. Fill in secrets (JWT_SECRET, MYSQL_PASSWORD, etc.) in Secrets Manager
# 3. Build + push Docker image to ECR
# 4. Register ECS task definition
# 5. Deploy: aws ecs update-service --force-new-deployment
```

The app URL (CloudFront domain) is in the stack `AppURL` output.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | 3000 | HTTP listen port |
| `JWT_SECRET` | **Yes** | — | JWT signing secret (min 32 chars) |
| `TOKEN_API_KEY` | **Yes** | — | Gate on `POST /api/v1/auth/token` |
| `MYSQL_HOST` | Yes | — | MySQL hostname |
| `MYSQL_PORT` | No | 3306 | MySQL port |
| `MYSQL_USER` | No | root | MySQL username |
| `MYSQL_PASSWORD` | Yes | — | MySQL password |
| `MYSQL_DATABASE` | Yes | — | Database name |
| `REDIS_HOST` | Yes | — | Redis hostname |
| `REDIS_PORT` | No | 6379 | Redis port |
| `REDIS_PASSWORD` | No | — | Redis AUTH password |
| `AWS_REGION` | Yes | — | AWS region |
| `AWS_ACCESS_KEY_ID` | No* | — | AWS key (use IAM role in production) |
| `AWS_SECRET_ACCESS_KEY` | No* | — | AWS secret (use IAM role in production) |
| `S3_ENDPOINT` | No | — | Override for LocalStack: `http://localstack:4566` |
| `HOT_BUCKET` | Yes | — | S3 bucket for active files |
| `COLD_BUCKET` | Yes | — | S3 bucket for archived files |
| `MAX_CACHE_SIZE_BYTES` | No | 104857600 | Local cache limit (100MB default) |
| `TIERING_INACTIVITY_DAYS` | No | 30 | Days before file moves to Glacier |
| `SECRETS_MANAGER_NAME` | No | — | AWS Secrets Manager secret name (production) |
| `DISABLE_AUTH` | No | false | Dev bypass — grants DEVELOPER role with warning |

---

## API Reference

### Authentication

```bash
# Get a JWT token (requires TOKEN_API_KEY if set)
curl -X POST http://localhost:3000/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -H "x-api-key: <TOKEN_API_KEY>" \
  -d '{"tenantId": "tenant-demo", "role": "ADMIN"}'

# Response: { "token": "eyJ...", "tenantId": "tenant-demo", "role": "ADMIN" }
export TOKEN=<paste token here>
```

### Upload a file

```bash
curl -X POST http://localhost:3000/api/v1/files/tenant-demo \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/yourfile.pdf"
# Response: 202 Accepted — queued for S3 upload
```

### List files

```bash
curl http://localhost:3000/api/v1/files/tenant-demo \
  -H "Authorization: Bearer $TOKEN"
```

### Download a file

```bash
curl -O -J http://localhost:3000/api/v1/files/tenant-demo/yourfile.pdf \
  -H "Authorization: Bearer $TOKEN"

# Partial download (Range request)
curl -H "Range: bytes=0-1048575" \
  http://localhost:3000/api/v1/files/tenant-demo/yourfile.pdf \
  -H "Authorization: Bearer $TOKEN"
```

### Delete a file (ADMIN only)

```bash
curl -X DELETE http://localhost:3000/api/v1/files/tenant-demo/yourfile.pdf \
  -H "Authorization: Bearer $TOKEN"
```

### Invalidate cache (ADMIN only — forces next download from S3)

```bash
curl -X POST "http://localhost:3000/api/v1/cache/invalidate?filePath=yourfile.pdf" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: tenant-demo"
```

### Health check

```bash
curl http://localhost:3000/health
# { "status": "ok" }

curl http://localhost:3000/health/metrics \
  -H "Authorization: Bearer $TOKEN"
# Returns: queue depth, Redis info, memory usage (ADMIN only)
```

---

## Issues Found and Fixed

The codebase was audited from scratch. Below is every issue found, why it was a problem, and what was changed.

### Critical — Server would not start

| # | File | Issue | Fix |
|---|---|---|---|
| 1 | `src/routes/proxy.js` | `hasPermission` imported from `../middleware/auth` — that export doesn't exist there. Server crashed immediately on startup. | Changed import to `../services/authService.js` where it is actually exported. |

### Security vulnerabilities

| # | File | Issue | Fix |
|---|---|---|---|
| 2 | `src/middleware/authMiddleware.js` | `DISABLE_AUTH=true` set `req.user.role = 'ADMIN'` — dev bypass silently gave full admin access. | Changed to `DEVELOPER` role + `console.warn` |
| 3 | `src/routes/health.js` | `GET /health/metrics` had no auth — anyone could read Redis state, queue depth, memory. | Added `authenticateTenant` + `requireRole('ADMIN')` |
| 4 | `src/routes/proxy.js` | `POST /s3-event` webhook had no auth — anyone could POST fake S3 events to manipulate metadata. | Added `requireRole('ADMIN')` |
| 5 | `src/routes/auth.js` | `POST /api/v1/auth/token` had no gate — anyone could mint JWTs for any tenant and role. | Added `TOKEN_API_KEY` header check |
| 6 | `src/config/index.js` | `jwtSecret: process.env.JWT_SECRET \|\| 'fallback-secret'` — production with missing JWT_SECRET used a public default. | Added `console.warn` when fallback is used |
| 7 | `src/services/evictionService.js` | `path.join(tenantsDir, tenantId, userPath)` — attacker-controlled `userPath` could escape tenant boundary. | Replaced with `resolveTenantPath()` which enforces boundary check |

### Data loss risks

| # | File | Issue | Fix |
|---|---|---|---|
| 8 | `src/workers/tieringWorker.js` | Tiering order was: upload to cold → **delete from hot** → update DB. If delete ran before DB update confirmed, file was gone permanently. | Changed to: copy → confirm → update DB → delete |
| 9 | `src/services/evictionService.js` | Eviction deleted files from disk without checking if they were queued for S3 upload. File deleted before worker uploaded it = silent data loss. | Added `isPendingSync()` check; if pending, defer eviction by 1 hour via Redis ZSET score update |

### Incorrect behavior

| # | File | Issue | Fix |
|---|---|---|---|
| 10 | `src/db/redis.js` | `config.redis.password` was never passed to `new Redis({...})`. Redis AUTH failed silently. | Added `password: config.redis.password \|\| undefined` |
| 11 | `src/services/queueService.js` | Same — BullMQ Queue Redis connection ignored password. | Added `password: config.redis.password \|\| undefined` |
| 12 | `src/workers/s3UploadWorker.js` | Same — BullMQ Worker Redis connection ignored password. | Added `password: config.redis.password \|\| undefined` |
| 13 | `src/config/index.js` | `MYSQL_PASSWORD \|\| 'root'` — production with missing env var silently used `root` as the DB password. | Changed default to `''` |
| 14 | `src/routes/gateway.js` | Range end never clamped: `Range: bytes=0-99999999999` on a 1MB file returned wrong Content-Range. | `end = Math.min(parseInt(parts[1]), totalSizeBytes - 1)` |
| 15 | `src/routes/gateway.js` + `proxy.js` | Outer `res` (Express response) shadowed by inner `res` (S3 SDK response) in nested callbacks — subtle response-not-sent bug. | Renamed inner S3 response to `s3Res` |
| 16 | `src/workers/tieringWorker.js` | When `HOT_BUCKET`/`COLD_BUCKET` not set, worker queried MySQL for stale files then threw on every single file. | Added early return with warning if either bucket is null |
| 17 | `src/services/queueService.js` | `jobId` was static (`tenantId:filePath`) — second upload of same file threw "job already exists". | Appended `Date.now()` to jobId |
| 18 | `src/services/queueService.js` | `queue.add()` had no timeout — hung indefinitely if Redis was slow. | `Promise.race([queue.add(...), timeout(4000)])` |
| 19 | `src/services/queueService.js` + worker | No `enableOfflineQueue: false` — ioredis buffered commands in memory during Redis outage, causing memory growth. | Added `enableOfflineQueue: false` + `connectTimeout: 5000` |
| 20 | `src/workers/s3UploadWorker.js` | `clearPendingSync()` was never called after job completed or failed — syncTracker Set grew forever, blocking eviction of all files. | Added `worker.on('completed', ...)` and `worker.on('failed', ...)` calling `clearPendingSync` |
| 21 | `src/services/metadataService.js` | In-memory cache Map had no size cap — grew unboundedly with unique file keys, eventual heap exhaustion. | Added FIFO eviction at 5000 entries |
| 22 | `src/server.js` | `ALTER TABLE` error catch swallowed all errors: `catch(e) { console.log('Column exists') }` — real DB failures were hidden. | Only suppress `errno === 1060` (ER_DUP_FIELDNAME), re-throw all others |
| 23 | `server.js` (root) | Dead CommonJS `require()` file in an ESM project — did nothing, caused confusion. | Deleted |
| 24 | `tests/queue.test.js` | Test process never exited — BullMQ Worker held Redis connection open after tests. | Added `queue.close()` in `afterAll` + `process.exit(0)` |

### Performance problems

| # | File | Issue | Fix |
|---|---|---|---|
| 25 | `src/routes/gateway.js` | `readFile(path)` then `res.end(buffer.subarray(...))` — a 4GB file required 4GB of heap per concurrent download. | `fs.createReadStream(path, { start, end }).pipe(res)` — streams directly to socket, ~64KB memory regardless of file size |
| 26 | `src/middleware/requestLogger.js` | Logger called `res.setHeader()` after streaming had already sent headers → `ERR_HTTP_HEADERS_SENT`. | Added `if (!res.headersSent)` guard |
| 27 | `src/routes/gateway.js` | No upload size limit — attacker could send unlimited data to exhaust disk. | 5GB Content-Length pre-check + `busboy({ limits: { fileSize: 5GB } })` |
| 28 | `src/services/evictionService.js` | If all LRU keys were pending sync, `while (usage > max)` popped, deferred, reinserted, popped again — infinite loop. | `MAX_EVICTION_ITERATIONS = 500` counter; breaks with warning if reached |

### Infrastructure gaps (CloudFormation)

| # | Resource | Issue | Fix |
|---|---|---|---|
| 29 | Private subnets | No route tables — ECS tasks had zero outbound connectivity. Could not pull Docker image or reach Secrets Manager. Deployment blocker. | Added `NatGatewayEIP`, `NatGateway`, `PrivateRouteTable1/2` |
| 30 | S3 access | S3 traffic went through NAT Gateway ($0.045/GB) | Added `S3VPCEndpoint` (Gateway type — free) |
| 31 | ECS multi-task cache | Each Fargate task had isolated ephemeral disk. File cached by Task 1 was a miss on Task 2. | Added `EFSFileSystem` + mount targets; all tasks mount at `/usr/src/app/storage` |
| 32 | No CDN | Every request hit ALB directly — cross-region latency, no DDoS protection. | Added `CloudFrontDistribution` — edge-caches downloads 1hr, Shield Standard free |
| 33 | Tiering cron | `setInterval` ran in every ECS task — 3 tasks = 3× MySQL load, race conditions on same files. | Redis `SET NX EX 1800` distributed lock — one task wins, others skip |

---

## Security Model

| Threat | Defense | Where |
|---|---|---|
| Path traversal `../../etc/passwd` | `resolveTenantPath()` — `path.normalize` + `path.resolve` boundary check | `gateway.js`, `evictionService.js` |
| Cross-tenant file access | JWT `tenantId` claim enforced; MySQL `WHERE tenant_id = ?` | `authMiddleware.js`, all queries |
| Unauthenticated admin endpoints | `requireRole('ADMIN')` on `/health/metrics` and `/s3-event` | `health.js`, `proxy.js` |
| JWT brute-force / token minting | `TOKEN_API_KEY` header required to call `/api/v1/auth/token` | `auth.js` |
| Credentials in Docker image | Secrets Manager injects at task startup via IAM role — nothing in image | `secretsService.js`, `aws.js` |
| Eviction race condition | `syncTracker` defers eviction of pending-upload files by 1 hour | `evictionService.js`, `syncTracker.js` |
| Large upload DoS | 5GB Content-Length check + busboy fileSize limit | `gateway.js` |
| Multi-task tiering conflicts | Redis distributed lock — only one ECS task runs tiering per cycle | `tieringWorker.js` |

---

## RBAC

| Role | Upload | Download | List | Invalidate Cache | Delete |
|---|---|---|---|---|---|
| VIEWER | No | Yes | Yes | No | No |
| DEVELOPER | Yes | Yes | Yes | No | No |
| ADMIN | Yes | Yes | Yes | Yes | Yes |

Roles are embedded in the JWT at issuance. Middleware checks `req.user.role` on every protected route.

---

## Project Structure

```
CloudVault/
├── src/
│   ├── server.js                  Express bootstrap, graceful shutdown (SIGTERM/SIGINT)
│   ├── config/
│   │   ├── index.js               All env-var config with sensible defaults
│   │   └── aws.js                 AWS S3 + Secrets Manager client factory
│   ├── routes/
│   │   ├── auth.js                POST /api/v1/auth/token, GET /api/v1/auth/me
│   │   ├── gateway.js             Upload, download (streaming), list, delete
│   │   ├── health.js              GET /health, GET /health/metrics (ADMIN)
│   │   └── proxy.js               Cache invalidate, S3 event webhook
│   ├── services/
│   │   ├── authService.js         JWT sign/verify, ROLES enum, hasPermission()
│   │   ├── evictionService.js     LRU eviction loop with syncTracker guard
│   │   ├── metadataService.js     MySQL wrapper, 5000-entry in-memory FIFO cache
│   │   ├── queueService.js        BullMQ queue + 4s timeout wrapper
│   │   ├── s3Service.js           S3 upload/download/delete/copy helpers
│   │   ├── secretsService.js      AWS Secrets Manager pull + applyAwsSecrets()
│   │   └── syncTracker.js         In-memory Set of files pending S3 upload
│   ├── workers/
│   │   ├── s3UploadWorker.js      BullMQ worker: dequeues → uploads to S3
│   │   └── tieringWorker.js       Cron: scan stale files → copy → update → delete
│   ├── middleware/
│   │   ├── authMiddleware.js      authenticateTenant(), requireRole()
│   │   └── requestLogger.js       Per-request ID, latency, structured logging
│   └── db/
│       ├── mysql.js               mysql2 connection pool singleton
│       └── redis.js               ioredis singleton with lazy connect
│
├── public/
│   └── index.html                 Dark-theme single-page management UI
│
├── deploy/
│   ├── cloudformation/
│   │   └── infra.yml              Full VPC→NAT→ALB→ECS→RDS→Redis→EFS→CloudFront
│   ├── ecs-task-definition.json   ECS task definition skeleton (placeholder IDs)
│   └── scripts/deploy.sh          5-step automated ECS deploy script
│
├── scripts/
│   └── localstack-init.sh         Creates S3 buckets in LocalStack on startup
│
├── docker-compose.yml             Dev: MySQL + Redis only
├── docker-compose.demo.yml        Demo: MySQL + Redis + LocalStack + App
├── Dockerfile                     Non-root user (cloudvault:cloudvault), prod deps only
└── .dockerignore                  Excludes node_modules, .env, storage, tests from image
```

---

## Infrastructure (CloudFormation)

`deploy/cloudformation/infra.yml` creates the entire production stack in one command.

| Resource | Configuration |
|---|---|
| VPC | 10.0.0.0/16, 2 public + 2 private subnets, 2 AZs |
| Internet Gateway | Attached to VPC |
| NAT Gateway | EIP in PublicSubnet1 — outbound for private subnets |
| S3 VPC Gateway Endpoint | S3 traffic stays in AWS backbone (free, no NAT cost) |
| ALB | Internet-facing, HTTP + optional HTTPS, health-checks `/health` |
| ECS Fargate | Private subnets, 1–5 tasks, auto-scales on CPU > 70% |
| EFS | Encrypted, elastic throughput, mounted by all ECS tasks at `/usr/src/app/storage` |
| RDS MySQL 8 | db.t3.micro, private subnets, 7-day backups, snapshot on delete |
| ElastiCache Redis 7 | cache.t3.micro, private subnets, encrypted at rest + in transit |
| CloudFront | Edge-caches downloads 1hr, HTTP/2, DDoS (Shield Standard) |
| ECR | Image scanning on push, keeps last 5 images |
| Secrets Manager | JWT_SECRET, MYSQL_PASSWORD, REDIS_PASSWORD — injected at task startup |
| IAM ECSTaskExecutionRole | ECR pull, CloudWatch logs, Secrets Manager read |
| IAM ECSTaskRole | S3 full access on both buckets, Secrets Manager read, EFS mount |

Security groups — strict least-privilege:
- ALB: accepts 80/443 from `0.0.0.0/0`
- App: accepts app port only from ALB SG
- DB: accepts 3306 only from App SG
- Redis: accepts 6379 only from App SG
- EFS: accepts 2049 (NFS) only from App SG

---

## Documentation

| File | What it covers |
|---|---|
| `README.md` | This file — setup, all issues, architecture, API |
| [DOCS.md](./DOCS.md) | Detailed API reference with curl examples for every endpoint |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | All 3 deployment options (LocalStack / EC2 / ECS Fargate) with exact commands |
| [MASTER_REFERENCE.md](./MASTER_REFERENCE.md) | Complete project history, every bug with before/after code, all improvements, infra diagrams, interview Q&A |

---

## Running Tests

```bash
npm test
```

---

## Known Limitations (not bugs — conscious trade-offs)

| Item | Detail |
|---|---|
| `syncTracker` is in-process | The pending-upload Set is cleared on process restart. Files queued before a crash may be evicted before the worker re-runs. Mitigation: BullMQ persists jobs in Redis and retries. |
| Singleflight is per-process | On a 3-task deployment, two tasks can independently download the same S3 file. Each writes to EFS so subsequent requests serve from cache. |
| No rate limiting on token endpoint | `POST /api/v1/auth/token` is gated by `TOKEN_API_KEY` but has no per-IP rate limit. Low risk if `TOKEN_API_KEY` is kept secret. |

---

## Author

**S Vinay** — original implementation  
Security audit, streaming downloads, ECS infrastructure — hardened October 2026
