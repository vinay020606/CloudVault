# 🚀 CloudVault - Multi-Tenant Storage Gateway & Reverse Proxy

[![Node.js](https://img.shields.io/badge/Node.js-20-green?style=flat&logo=node.js)](https://nodejs.org/)
[![Redis](https://img.shields.io/badge/Redis-Caching-red?style=flat&logo=redis)](https://redis.io/)
[![AWS S3](https://img.shields.io/badge/AWS-S3-orange?style=flat&logo=amazon-aws)](https://aws.amazon.com/s3/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-blue?style=flat&logo=mysql)](https://www.mysql.com/)
[![Docker](https://img.shields.io/badge/Docker-Containerized-blue?style=flat&logo=docker)](https://www.docker.com/)

---

## 📌 What is CloudVault?

**CloudVault** is a high-performance **Storage Gateway & Reverse Proxy** that sits between your client applications and **AWS S3**.

Instead of client apps downloading files directly from S3 (which is slow and incurs cloud egress fees), CloudVault acts as an intelligent **local caching proxy and security firewall**.

- **First Download (Cache Miss):** Fetches the file from AWS S3, saves it to local disk storage, and streams it to the user (~180ms).
- **Subsequent Downloads (Cache Hit):** Serves the file directly from local NVMe/SSD storage (**~3.8ms — 48x faster!**).

---

## 🔄 How CloudVault Acts as a Reverse Proxy

CloudVault operates as a **Reverse Storage Proxy** for AWS S3:

1. **Shielding AWS Infrastructure & Credentials:** Clients never possess AWS Access Keys (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) or direct S3 bucket URLs. The S3 bucket remains **100% private** with public access blocked.
2. **Transparent HTTP Proxy Routes (`/proxy/:tenantId/*`):**
   - **Upload (`PUT` / `POST`):** Client streams file to `http://gateway:3000/proxy/tenant_101/docs/report.pdf`. CloudVault validates security, writes to local cache, records MySQL metadata, and pipes data in the background to AWS S3 (`tenants/tenant_101/docs/report.pdf`).
   - **Download (`GET`):** Client requests `http://gateway:3000/proxy/tenant_101/docs/report.pdf`. CloudVault checks local SSD storage. If present, it returns HTTP 200 with `X-Cache-Status: CACHE_HIT`. If missing, it fetches from S3 via Singleflight, caches locally, and returns `X-Cache-Status: CACHE_MISS_S3_FETCH`.
   - **Delete (`DELETE`):** Client sends `DELETE /proxy/tenant_101/docs/report.pdf`. CloudVault removes the file from local SSD, MySQL metadata, and Redis LRU tracking.

---

## 🗄️ Database Schema (MySQL 8.0)

MySQL acts as the authoritative relational database storing file metadata, ownership, and S3 keys.

### `files` Table Schema

```sql
CREATE TABLE IF NOT EXISTS files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(255) NOT NULL,
  file_path VARCHAR(768) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL,
  s3_key VARCHAR(1024) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY idx_tenant_path (tenant_id, file_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### What Each Field Stores:

| Column | Data Type | Purpose / Description |
| :--- | :--- | :--- |
| `id` | `INT` (Primary Key) | Unique incremental file ID. |
| `tenant_id` | `VARCHAR(255)` | Identifies tenant owner (enforces multi-tenant metadata isolation). |
| `file_path` | `VARCHAR(768)` | Logical file path requested by tenant (e.g. `documents/report.pdf`). |
| `file_name` | `VARCHAR(255)` | Original filename (e.g. `report.pdf`). |
| `size_bytes` | `BIGINT` | Total file size in bytes. |
| `s3_key` | `VARCHAR(1024)` | Exact AWS S3 Object Key (e.g. `tenants/tenant_101/documents/report.pdf`). |
| `created_at` | `TIMESTAMP` | Upload timestamp. |

---

## ⚡ What Redis Stores & LRU Scoring

Redis is used for **high-speed in-memory indexing and LRU (Least Recently Used) tracking**.

### Redis Data Structure: Sorted Set (`ZSET`)
- **Redis Key:** `cloudvault:lru_files`
- **Member Format:** `${tenantId}:${filePath}` (e.g. `tenant_101:documents/report.pdf`)
- **Score:** Unix timestamp in milliseconds (`Date.now()`)

### How Redis Tracks File Popularity:
Whenever a file is **uploaded** or **downloaded**, CloudVault calls `touchFile(redis, fileKey)`:
```javascript
// Updates or inserts the file's score to the current timestamp
await redis.zadd('cloudvault:lru_files', Date.now(), 'tenant_101:documents/report.pdf');
```
This maintains a real-time list of all cached files, ordered strictly from **oldest accessed (lowest score)** to **most recently accessed (highest score)**.

---

## 🧹 How Automatic Eviction Works (Redis LRU Watcher)

CloudVault includes a background interval worker `startEvictionWatcher()` that continuously monitors local SSD disk usage to prevent disk space exhaustion.

```mermaid
graph TD;
    Start[Eviction Watcher Interval - Every 10s]-->Calc[1. Calculate Total Local Folder Size ./storage/tenants/];
    Calc-->Check{Folder Size > MAX_CACHE_SIZE?};
    Check-- No -->End[Sleep / Wait for Next Interval];
    Check-- Yes (Over Budget) -->Fetch[2. Query Redis: ZRANGE cloudvault:lru_files 0 0];
    Fetch-->Identify[Oldest Unaccessed File Key Identified];
    Identify-->DeleteDisk[3. Delete Physical File from Local SSD Disk];
    DeleteDisk-->RemoveRedis[4. Remove File Key from Redis ZREM cloudvault:lru_files fileKey];
    RemoveRedis-->Check;
```

### Detailed Eviction Step-by-Step:
1. **Size Calculation:** Background worker measures total size of all files in `./storage/tenants/`.
2. **Threshold Check:** If total size exceeds `MAX_CACHE_SIZE_BYTES` (e.g., 100MB):
3. **Fetch Oldest File:** Queries Redis for the single oldest file score:
   ```javascript
   const oldest = await redis.zrange('cloudvault:lru_files', 0, 0);
   // Returns: ['tenant_101:documents/old_report.pdf']
   ```
4. **Physical Disk Unlink:** Deletes the physical file from local SSD storage:
   ```javascript
   await fs.promises.unlink('./storage/tenants/tenant_101/documents/old_report.pdf');
   ```
5. **Remove Index:** Removes the key from Redis:
   ```javascript
   await redis.zrem('cloudvault:lru_files', 'tenant_101:documents/old_report.pdf');
   ```
6. **Loop Until Healthy:** Repeats until total folder size drops safely below the cache limit.
7. **Transparent Recovery:** If an evicted file is requested by a user later, CloudVault detects a Cache Miss, fetches it from S3 via Singleflight, saves it back to local SSD, and re-indexes it in Redis!

---

## 🛡️ Multi-Tenant Security & Path Traversal Prevention

CloudVault uses a native sanitization utility `resolveTenantPath(tenantId, filePath)` to enforce strict multi-tenant boundary isolation:

```javascript
// Validates path stays inside ./storage/tenants/<tenantId>/
const targetLocalPath = resolveTenantPath(tenantId, userRequestedPath);
```

- **Allowed:** `resolveTenantPath('tenant_101', 'documents/notes.txt')` $\rightarrow$ `./storage/tenants/tenant_101/documents/notes.txt`
- **Blocked Attack:** `resolveTenantPath('tenant_101', '../tenant_202/secret.txt')` $\rightarrow$ Throws `SecurityError` (**HTTP 403 Forbidden**).

---

## 🚀 Quick Start & Benchmarking

### 1. Run with Docker Compose
```bash
docker-compose up --build -d
```

### 2. Run Automated Unit Tests
```bash
npm test
```

### 3. Run Performance & Latency Benchmark
```bash
npm run benchmark
```

**Benchmark Output:**
```text
======================================================
📊 BENCHMARK RESULTS SUMMARY
======================================================
☁️  First Download (S3 Cache Miss):    186.74 ms
🚀 Second Download (Local Cache Hit):   3.86 ms
⚡ Speed Improvement:                   48.4x FASTER!
======================================================
```

---

## 👨‍💻 Author
**S Vinay**
