# CloudVault Gateway - Testing Guide

This document contains step-by-step instructions and `curl` commands to test and validate all core features of the CloudVault Gateway.

---

## 🚀 Setup & Environment

### Option 1: Docker Compose Setup
Run MySQL 8.0, Redis Alpine, and the Node.js App container simultaneously:
```bash
docker-compose up --build -d
```

### Option 2: Local Node.js Execution
Start local development server:
```bash
npm install
npm start
```

---

## 🧪 Automated Unit Test Suite

Run the full automated test suite covering Path Sanitizer security (traversal prevention), Direct Whole-File Tenant Storage, Singleflight coalescing (20 concurrent requests), and Redis LRU Eviction:

```bash
npm test
```

---

## ⚡ Latency & Speed Improvement Benchmark

Run the automated performance benchmark to measure Cache Miss vs Cache Hit latency:

```bash
npm run benchmark
```

**Sample Output:**
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

## 🔁 Transparent Storage Proxy REST Endpoints

CloudVault can also be used directly as a transparent HTTP S3 Proxy Layer using `/proxy/:tenantId/*` routes:

### 1. Upload via Storage Proxy (`PUT` / `POST`)
```bash
curl -X PUT "http://localhost:3000/proxy/tenant_101/documents/report.pdf" \
  --data-binary "@./sample.pdf"
```

### 2. Download via Storage Proxy (`GET`)
```bash
curl -X GET "http://localhost:3000/proxy/tenant_101/documents/report.pdf" \
  -i --output downloaded_proxy_report.pdf
```
*Response Headers will include:*
- `X-Cache-Status: CACHE_HIT` (or `CACHE_MISS_S3_FETCH`)
- `X-Storage-Proxy: CloudVault`

### 3. Delete via Storage Proxy (`DELETE`)
```bash
curl -X DELETE "http://localhost:3000/proxy/tenant_101/documents/report.pdf"
```

---

## 📡 Gateway API Testing with `curl`

### 1. Upload File (Stream $\rightarrow$ Path Sanitizer $\rightarrow$ MySQL Metadata $\rightarrow$ S3)

Upload a file for tenant `tenant_101`:

```bash
curl -X POST "http://localhost:3000/api/v1/gateway/upload" \
  -H "x-tenant-id: tenant_101" \
  -F "filePath=documents/report.pdf" \
  -F "file=@./sample.pdf"
```

**Expected Response (`HTTP 201 Created`):**
```json
{
  "message": "File uploaded successfully",
  "file": {
    "id": 1,
    "tenantId": "tenant_101",
    "filePath": "documents/report.pdf",
    "fileName": "sample.pdf",
    "sizeBytes": 123456,
    "s3Key": "tenants/tenant_101/documents/report.pdf"
  }
}
```

---

### 2. Download File (Cache Hit Scenario)

Download the file when present in local disk storage `./storage/tenants/tenant_101/documents/report.pdf`:

```bash
curl -X GET "http://localhost:3000/api/v1/gateway/download?filePath=documents/report.pdf" \
  -H "x-tenant-id: tenant_101" \
  --output downloaded_report.pdf
```

**Expected Result:**
`HTTP 200 OK` (or `HTTP 206 Partial Content` if `Range` header sent). `downloaded_report.pdf` matches original file.

---

### 3. Download File (Cache Miss & Singleflight S3 Fetch)

Simulate a cache miss by deleting the file from local disk storage `./storage/tenants/tenant_101/documents/report.pdf`, then requesting download. The gateway will fetch the missing file from S3 via `singleflightService`:

```bash
# 1. Delete file from local disk to force cache miss
rm ./storage/tenants/tenant_101/documents/report.pdf

# 2. Trigger download
curl -X GET "http://localhost:3000/api/v1/gateway/download?filePath=documents/report.pdf" \
  -H "x-tenant-id: tenant_101" \
  --output downloaded_report_miss.pdf
```

**Expected Result:**
Server logs `[Cache Miss] File tenant_101:documents/report.pdf missing locally. Fetching via Singleflight from S3...`, downloads file from S3 (`tenants/tenant_101/documents/report.pdf`), writes to local disk, updates Redis LRU timestamp, and returns complete file with `HTTP 200 OK`.

---

### 4. Path Traversal Security Validation

Validate that path traversal attempts (`../`) are detected and blocked with an explicit `SecurityError`:

#### Test A: Upload Path Traversal Attack
```bash
curl -i -X POST "http://localhost:3000/api/v1/gateway/upload" \
  -H "x-tenant-id: tenant_101" \
  -F "filePath=../tenant_202/malicious.txt" \
  -F "file=@./sample.txt"
```

**Expected Response (`HTTP 403 Forbidden`):**
```json
{
  "error": "Path traversal detected: Attempted to escape tenant root directory (../tenant_202/malicious.txt)"
}
```

#### Test B: Download Path Traversal Attack
```bash
curl -i -X GET "http://localhost:3000/api/v1/gateway/download?filePath=../../etc/passwd" \
  -H "x-tenant-id: tenant_101"
```

**Expected Response (`HTTP 403 Forbidden`):**
```json
{
  "error": "Path traversal detected: Attempted to escape tenant root directory (../../etc/passwd)"
}
```
