# CloudVault — Multi-Tenant Cloud Storage Gateway

[![Node.js](https://img.shields.io/badge/Node.js-20_ESM-green?style=flat&logo=node.js)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4-lightgrey?style=flat&logo=express)](https://expressjs.com/)
[![AWS S3](https://img.shields.io/badge/AWS-S3_SDK_v3-orange?style=flat&logo=amazon-aws)](https://aws.amazon.com/s3/)
[![Redis](https://img.shields.io/badge/Redis-LRU_Cache-red?style=flat&logo=redis)](https://redis.io/)
[![MySQL](https://img.shields.io/badge/MySQL-8-blue?style=flat&logo=mysql)](https://www.mysql.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue?style=flat&logo=docker)](https://www.docker.com/)
[![ECS](https://img.shields.io/badge/AWS-ECS_Fargate-orange?style=flat&logo=amazon-aws)](https://aws.amazon.com/ecs/)

---

## What is CloudVault

CloudVault is a **multi-tenant storage gateway** that sits in front of AWS S3. Instead of clients hitting S3 directly, every upload and download routes through this Express server, which:

- Caches hot files on a local SSD — serves repeat downloads in ~4ms instead of ~180ms S3 latency
- Queues S3 uploads asynchronously via BullMQ so clients get a `202 Accepted` instantly
- Tiers cold files (30+ days untouched) from S3 Standard to Glacier automatically
- Enforces tenant isolation — tenant A can never access tenant B's files
- Enforces RBAC via JWT — `ADMIN` / `DEVELOPER` / `VIEWER` roles

---

## Architecture Overview

```
Internet
  │
  ▼
CloudFront CDN (edge cache — GET /api/v1/files/* cached 1hr at edge)
  │
  ▼
ALB (public subnets, 2 AZs)
  │  HTTP/HTTPS → port 3000
  ▼
ECS Fargate Tasks (private subnets)
  ├── Auth middleware (JWT + RBAC)
  ├── Path sanitizer (resolveTenantPath — blocks traversal)
  │
  ├── Upload:
  │     Write to EFS /storage/tenants/<tenantId>/   ← shared across all tasks
  │     → markPendingSync → BullMQ enqueue → 202
  │     → Worker dequeues → streams to S3 (via VPC Gateway Endpoint — free)
  │
  └── Download:
        Cache hit?  → touch Redis LRU → stream from EFS (206/200)
        Cache miss? → singleflight S3 fetch → write EFS → stream (206/200)
        Cold tier?  → 503 (Glacier restore required)
  │
  ├── RDS MySQL 8 (private DB subnets) — metadata
  ├── ElastiCache Redis 7 (private DB subnets) — LRU sorted set
  └── EFS (shared cache volume, mounted by all tasks)

Background:
  BullMQ Worker  — dequeues S3 uploads, 5 retries + backoff
  Tiering Cron   — every 30 min, Redis distributed lock (one task only)
  Eviction Loop  — per upload: LRU evict if usage > MAX_CACHE_SIZE_BYTES

Outbound routing (private subnets):
  S3 traffic     → VPC Gateway Endpoint (free, stays in AWS backbone)
  Everything else → NAT Gateway → Internet Gateway
```

---

## Quick Start

### Option 1 — Local dev (Node + Docker Compose for MySQL/Redis)

```bash
git clone https://github.com/vinay020606/CloudVault.git
cd CloudVault
cp .env.example .env
# Edit .env — fill in JWT_SECRET and AWS credentials

docker-compose up -d        # starts MySQL + Redis
node src/server.js          # PORT=3099 if 3000 is taken
```

Open http://localhost:3000 (or 3099) for the management UI.

### Option 2 — Full demo with LocalStack (no AWS account needed)

```bash
docker-compose -f docker-compose.demo.yml up --build
```

Starts MySQL, Redis, LocalStack (S3 emulation), and the app. S3 buckets are auto-created by `scripts/localstack-init.sh`. All operations work end-to-end with no real AWS credentials.

### Option 3 — Production on AWS ECS Fargate

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full 5-step guide using the included CloudFormation template.

---

## Configuration

Copy `.env.example` to `.env` and fill in values. All sensitive values should be stored in AWS Secrets Manager in production — see [DEPLOYMENT.md](./DEPLOYMENT.md).

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | HTTP port (default: 3000) |
| `JWT_SECRET` | **Yes** | Secret for signing JWTs |
| `TOKEN_API_KEY` | **Yes** | API key required on `POST /api/v1/auth/token` |
| `MYSQL_HOST` | Yes | MySQL hostname |
| `MYSQL_PORT` | No | MySQL port (default: 3306) |
| `MYSQL_USER` | Yes | MySQL user |
| `MYSQL_PASSWORD` | Yes | MySQL password |
| `MYSQL_DATABASE` | Yes | Database name |
| `REDIS_HOST` | Yes | Redis hostname |
| `REDIS_PORT` | No | Redis port (default: 6379) |
| `REDIS_PASSWORD` | No | Redis password (if AUTH enabled) |
| `AWS_REGION` | Yes | AWS region |
| `AWS_ACCESS_KEY_ID` | Yes* | AWS key (injected via Secrets Manager in prod) |
| `AWS_SECRET_ACCESS_KEY` | Yes* | AWS secret (injected via Secrets Manager in prod) |
| `S3_ENDPOINT` | No | Override S3 endpoint (set to `http://localstack:4566` for demo) |
| `HOT_BUCKET` | Yes | S3 bucket name for active files |
| `COLD_BUCKET` | Yes | S3 bucket name for archived files |
| `MAX_CACHE_SIZE_BYTES` | No | SSD cache limit per tenant (default: 104857600 = 100MB) |
| `TIERING_INACTIVITY_DAYS` | No | Days before file moves to Glacier (default: 30) |
| `SECRETS_MANAGER_NAME` | No | AWS Secrets Manager secret name (production) |
| `DISABLE_AUTH` | No | Set `true` for dev-only; grants DEVELOPER role with warning |

---

## API Reference

Full curl examples in [DOCS.md](./DOCS.md). Summary:

| Method | Path | Role | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/token` | — | Issue JWT (requires `TOKEN_API_KEY` header) |
| `POST` | `/api/v1/files/:tenantId` | DEVELOPER+ | Upload file (multipart/form-data) |
| `GET` | `/api/v1/files/:tenantId` | VIEWER+ | List tenant files |
| `GET` | `/api/v1/files/:tenantId/:filePath` | VIEWER+ | Download file (Range requests supported) |
| `DELETE` | `/api/v1/files/:tenantId/:filePath` | ADMIN | Delete file |
| `POST` | `/api/v1/cache/invalidate` | ADMIN | Evict file from SSD cache |
| `GET` | `/health` | — | Liveness check |
| `GET` | `/health/metrics` | ADMIN | Queue depth, memory, Redis status |

---

## Security

| Threat | Defense |
|---|---|
| Path traversal (`../../etc/passwd`) | `resolveTenantPath()` — `path.normalize` + `path.resolve` boundary check |
| Cross-tenant data access | JWT `tenantId` claim + MySQL `WHERE tenant_id = ?` |
| Unauthenticated metrics/webhooks | `requireRole('ADMIN')` on `/health/metrics` and `/s3-event` |
| Brute-force token generation | `TOKEN_API_KEY` header gate on auth endpoint |
| Credential exposure | AWS credentials injected at runtime via Secrets Manager, never in image |
| Eviction race condition | `syncTracker` defers eviction of pending-upload files by 1 hour |

---

## Project Structure

```
src/
├── server.js                 # Express bootstrap, graceful shutdown
├── config/
│   ├── index.js              # All env-var config
│   └── aws.js                # AWS client factory (S3, Secrets Manager)
├── routes/
│   ├── gateway.js            # Upload, download, delete
│   └── proxy.js              # Cache invalidate, health, metrics
├── services/
│   ├── authService.js        # JWT sign/verify + RBAC
│   ├── evictionService.js    # LRU eviction loop
│   ├── metadataService.js    # MySQL wrapper
│   ├── queueService.js       # BullMQ queue + timeout wrapper
│   ├── s3Service.js          # S3 upload/download helpers
│   ├── secretsService.js     # Secrets Manager pull
│   └── syncTracker.js        # Pending-upload protection Set
├── workers/
│   ├── s3UploadWorker.js     # BullMQ worker: dequeues → uploads to S3
│   └── tieringWorker.js      # Cron: scan stale files → move to Glacier
├── middleware/
│   ├── auth.js               # requireAuth / requireRole
│   └── requestLogger.js      # Per-request structured logging
└── db/
    ├── mysql.js              # MySQL connection pool
    └── redis.js              # ioredis singleton

public/
└── index.html                # Dark-theme management UI

deploy/
├── cloudformation/infra.yml  # Full VPC→ECS→RDS→ElastiCache CF template
├── ecs-task-definition.json  # ECS task definition skeleton
└── scripts/deploy.sh         # 5-step deploy script

docker-compose.yml            # Dev: MySQL + Redis
docker-compose.demo.yml       # Demo: MySQL + Redis + LocalStack + App
Dockerfile                    # Non-root user, production deps only
```

---

## Infrastructure (CloudFormation)

The included `deploy/cloudformation/infra.yml` creates the full stack in one command:

| Resource | Detail |
|---|---|
| VPC | 10.0.0.0/16, 2 public + 2 private subnets across 2 AZs |
| NAT Gateway | EIP in PublicSubnet1 — gives private tasks outbound internet |
| S3 VPC Gateway Endpoint | S3 traffic stays within AWS backbone (free) |
| ALB | Internet-facing, HTTP/HTTPS, health-checks `/health` |
| ECS Fargate | Private subnets, 1–5 tasks, CPU auto-scaling at 70% |
| EFS | Encrypted shared cache volume, elastic throughput, 30-day IA lifecycle |
| RDS MySQL 8 | Private subnets, 7-day backups, snapshot on delete |
| ElastiCache Redis 7 | Private subnets, encrypted at rest + in transit |
| CloudFront | Edge cache, HTTP/2, DDoS protection (Shield Standard) |
| ECR | Image scanning on push, keeps last 5 images |
| Secrets Manager | Runtime credential injection — no credentials in image or task definition |
| IAM | ECSTaskExecutionRole (ECR + CW + Secrets), ECSTaskRole (S3 + Secrets + EFS) |

---

## Documentation

| File | Contents |
|---|---|
| [DOCS.md](./DOCS.md) | Full API reference, all env vars, curl examples |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | All 3 deployment options with exact commands |
| [MASTER_REFERENCE.md](./MASTER_REFERENCE.md) | Full project history, all bugs found and fixed, architecture flows, infrastructure diagrams, interview Q&A |

---

## Running Tests

```bash
npm test
```

---

## Author

**S Vinay** — original implementation  
Security audit, streaming fixes, ECS deployment infrastructure — reviewed and hardened in October 2026
