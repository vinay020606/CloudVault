# CloudVault — Deployment Strategy

Three tiers depending on your situation:

| Option | Time to live | Cost | Real AWS? | Best for |
|---|---|---|---|---|
| A. Local Demo (LocalStack) | 5 min | $0 | No (simulated) | Demos, dev, CI |
| B. AWS EC2 (Free Tier) | 20 min | ~$0/mo | Yes | Demo with real S3 |
| C. Production (ECS + RDS) | 1–2 hrs | ~$50–100/mo | Yes | Real deployment |

---

## Option A — Local Demo with LocalStack (Recommended for demos)

No AWS account needed. LocalStack simulates S3 locally inside Docker. Everything runs in one command.

### Prerequisites
- Docker Desktop running
- Git

### Steps

```bash
# 1. Clone and enter the repo
git clone https://github.com/vinay020606/CloudVault
cd CloudVault

# 2. Start everything (MySQL + Redis + LocalStack + App)
docker-compose -f docker-compose.demo.yml up --build

# 3. Open the UI
open http://localhost:3000
```

That's it. The LocalStack init script automatically creates the two S3 buckets (`cloudvault-hot`, `cloudvault-cold`) on startup.

### What you can demo

- Upload files via the UI → stored locally + synced to LocalStack S3
- Download files → cache hit from local disk (~4ms)
- Delete a file's local cache (Invalidate) → next download fetches from LocalStack S3 (cache miss simulation)
- Role switching (ADMIN / DEVELOPER / VIEWER) to show RBAC
- Health metrics at `http://localhost:3000/health/metrics` (need ADMIN JWT from UI)

### Simulate a cache miss for the demo

```bash
# After uploading a file called "demo.pdf":

# 1. Get an ADMIN token from the UI (copy from token box)
TOKEN=<paste token>

# 2. Invalidate the local cache for that file
curl -X POST "http://localhost:3000/api/v1/gateway/invalidate?filePath=demo.pdf" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: tenant-alex"

# 3. Download it again — watch the server logs show "Cache Miss... Fetching from S3"
curl -O -J "http://localhost:3000/api/v1/gateway/download?filePath=demo.pdf" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-tenant-id: tenant-alex"
```

### Verify LocalStack S3 directly

```bash
# List objects in the hot bucket
docker exec cloudvault-demo-localstack \
  awslocal s3 ls s3://cloudvault-hot --recursive
```

### Tear down

```bash
docker-compose -f docker-compose.demo.yml down -v
```

---

## Option B — AWS EC2 (Free Tier, Real S3)

One EC2 instance running the full stack. Uses t3.micro (free tier eligible). MySQL and Redis run in Docker on the same instance. Real S3 for storage.

### AWS setup (one-time, ~10 minutes)

**Step 1 — Create two S3 buckets**

In AWS Console → S3 → Create bucket:
- `cloudvault-hot-standard` (S3 Standard, block public access ON)
- `cloudvault-cold-glacier` (S3 Standard, block public access ON)

**Step 2 — Create IAM user for the app**

In AWS Console → IAM → Users → Create user:
- Name: `cloudvault-app`
- Attach this inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:HeadObject",
        "s3:CopyObject",
        "s3:RestoreObject"
      ],
      "Resource": [
        "arn:aws:s3:::cloudvault-hot-standard/*",
        "arn:aws:s3:::cloudvault-cold-glacier/*"
      ]
    }
  ]
}
```

Save the Access Key ID and Secret Access Key.

**Step 3 — Launch EC2 instance**

- AMI: Amazon Linux 2023 (free tier)
- Type: t3.micro
- Storage: 20 GB gp3
- Security group: allow inbound TCP 22 (SSH), 3000 (app)
- Key pair: create or use existing

**Step 4 — SSH in and deploy**

```bash
ssh -i your-key.pem ec2-user@<your-ec2-ip>

# Install Docker
sudo yum update -y
sudo yum install -y docker git
sudo service docker start
sudo usermod -aG docker ec2-user
newgrp docker

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
  -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Clone the repo
git clone https://github.com/vinay020606/CloudVault
cd CloudVault

# Create .env
cp .env.example .env
```

**Step 5 — Fill in .env**

```bash
nano .env
```

Set these values:
```env
PORT=3000
JWT_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
TOKEN_API_KEY=<a random key to protect token issuance>

MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=<strong password>
MYSQL_DATABASE=cloudvault

REDIS_HOST=redis
REDIS_PORT=6379

TENANTS_STORAGE_DIR=/usr/src/app/storage/tenants
MAX_CACHE_SIZE_BYTES=1073741824

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<your IAM access key>
AWS_SECRET_ACCESS_KEY=<your IAM secret key>
HOT_BUCKET=cloudvault-hot-standard
S3_BUCKET_NAME=cloudvault-hot-standard
COLD_BUCKET=cloudvault-cold-glacier
TIERING_INACTIVITY_DAYS=30
```

**Step 6 — Start**

```bash
# Update docker-compose.yml to use your MYSQL_PASSWORD (it currently has 'root')
# Then:
docker-compose up --build -d
docker-compose logs -f app
```

App is now live at `http://<your-ec2-ip>:3000`.

### Optional: Add a domain + HTTPS

```bash
# Install nginx
sudo yum install -y nginx

# /etc/nginx/conf.d/cloudvault.conf
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}

sudo nginx -t && sudo systemctl start nginx && sudo systemctl enable nginx

# Free HTTPS with Certbot
sudo yum install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## Option C — Production on AWS ECS Fargate

For a real deployment. No servers to manage.

### Architecture

```
Internet
   │
   ▼
Application Load Balancer (HTTPS, ACM cert)
   │
   ▼
ECS Fargate Service (CloudVault container, auto-scaling)
   │
   ├── Amazon RDS MySQL 8 (db.t3.micro, Multi-AZ optional)
   ├── Amazon ElastiCache Redis (cache.t3.micro)
   ├── S3 Hot Bucket (Standard)
   ├── S3 Cold Bucket (Glacier)
   └── AWS Secrets Manager (stores DB password, Redis password, JWT secret)
```

### Steps (high level)

**1. Push Docker image to ECR**

```bash
aws ecr create-repository --repository-name cloudvault --region us-east-1

# Get login
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com

# Build and push
docker build -t cloudvault .
docker tag cloudvault:latest <account>.dkr.ecr.us-east-1.amazonaws.com/cloudvault:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/cloudvault:latest
```

**2. Create Secrets Manager secret**

```bash
aws secretsmanager create-secret \
  --name cloudvault/production/secrets \
  --secret-string '{
    "JWT_SECRET": "<64-byte-hex>",
    "TOKEN_API_KEY": "<random>",
    "MYSQL_PASSWORD": "<strong>",
    "REDIS_PASSWORD": "<strong>",
    "AWS_ACCESS_KEY_ID": "",
    "AWS_SECRET_ACCESS_KEY": ""
  }'
```

Leave `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` empty — ECS task role handles S3 access automatically.

**3. ECS Task Definition environment variables**

Set these as non-secret env vars (no sensitive values here):

```env
PORT=3000
AWS_REGION=us-east-1
MYSQL_HOST=<rds-endpoint>
MYSQL_PORT=3306
MYSQL_USER=cloudvault
MYSQL_DATABASE=cloudvault
REDIS_HOST=<elasticache-endpoint>
REDIS_PORT=6379
TENANTS_STORAGE_DIR=/usr/src/app/storage/tenants
MAX_CACHE_SIZE_BYTES=10737418240
HOT_BUCKET=cloudvault-hot-standard
S3_BUCKET_NAME=cloudvault-hot-standard
COLD_BUCKET=cloudvault-cold-glacier
SECRETS_MANAGER_NAME=cloudvault/production/secrets
TIERING_INACTIVITY_DAYS=30
```

**4. IAM Task Role permissions**

The ECS task role needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject","s3:GetObject","s3:DeleteObject","s3:HeadObject","s3:CopyObject","s3:RestoreObject"],
      "Resource": ["arn:aws:s3:::cloudvault-hot-standard/*","arn:aws:s3:::cloudvault-cold-glacier/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:us-east-1:*:secret:cloudvault/production/*"
    }
  ]
}
```

**5. Service auto-scaling**

```bash
# Scale on CPU > 70%
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/<cluster>/<service> \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 1 \
  --max-capacity 5
```

### Cost estimate (us-east-1, light load)

| Service | Config | Monthly |
|---|---|---|
| ECS Fargate | 0.25 vCPU, 0.5 GB, 1 task | ~$9 |
| RDS MySQL | db.t3.micro, 20 GB | ~$15 |
| ElastiCache Redis | cache.t3.micro | ~$12 |
| S3 | 100 GB + 100k requests | ~$3 |
| ALB | 1 LCU | ~$16 |
| **Total** | | **~$55/mo** |

---

## Quick Reference — Useful Commands

```bash
# View app logs
docker-compose logs -f app

# Check health
curl http://localhost:3000/health

# Get ADMIN JWT
curl -X POST http://localhost:3000/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"tenantId": "demo-tenant", "role": "ADMIN"}'

# Upload a file
curl -X POST "http://localhost:3000/api/v1/gateway/upload?filePath=test.txt" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "x-tenant-id: demo-tenant" \
  -H "Content-Type: text/plain" \
  --data-binary "Hello CloudVault"

# List files
curl http://localhost:3000/api/v1/gateway/files \
  -H "Authorization: Bearer <TOKEN>" \
  -H "x-tenant-id: demo-tenant"

# Download a file
curl -O -J "http://localhost:3000/api/v1/gateway/download?filePath=test.txt" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "x-tenant-id: demo-tenant"

# Run tests
npm test

# Rebuild containers after code changes
docker-compose -f docker-compose.demo.yml up --build
```
