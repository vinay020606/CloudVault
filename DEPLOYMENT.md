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

For a real deployment. No servers to manage. The included CloudFormation template creates everything in one command.

### Architecture

```
Internet
   │
   ▼
CloudFront CDN (edge cache, DDoS protection, HTTPS)
   │
   ▼
ALB (public subnets, 2 AZs)
   │
   ▼
ECS Fargate (private app subnets, 1–5 tasks, auto-scaling)
   │           │           │           │
   ▼           ▼           ▼           ▼
RDS MySQL   ElastiCache  EFS shared   S3 (via VPC
(private)   Redis        cache vol    Gateway Endpoint)
             (private)   (all tasks)

Outbound: private subnets → NAT Gateway → Internet Gateway
          S3 traffic → VPC Gateway Endpoint (free, bypasses NAT)
Secrets:  Secrets Manager → injected at task start via ECSTaskRole IAM
```

### Step 1 — Deploy CloudFormation stack

```bash
aws cloudformation deploy \
  --template-file deploy/cloudformation/infra.yml \
  --stack-name cloudvault-prod \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      Environment=production \
      HotBucketName=<your-unique-hot-bucket-name> \
      ColdBucketName=<your-unique-cold-bucket-name>
```

This creates: VPC, NAT Gateway, ALB, ECS Cluster, RDS, ElastiCache, **EFS**, CloudFront, ECR, Secrets Manager, all IAM roles.

Get the stack outputs (you'll need these in later steps):

```bash
aws cloudformation describe-stacks \
  --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs' \
  --output table
```

Key outputs: `AppURL`, `ECRRepositoryURI`, `SecretsManagerARN`, `DBEndpoint`, `RedisEndpoint`, `EFSFileSystemId`.

### Step 2 — Fill in Secrets Manager

```bash
SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`SecretsManagerARN`].OutputValue' \
  --output text)

aws secretsmanager put-secret-value \
  --secret-id $SECRET_ARN \
  --secret-string '{
    "JWT_SECRET": "<64-byte-hex — node -e console.log(require(crypto).randomBytes(64).toString(hex))>",
    "TOKEN_API_KEY": "<random string>",
    "MYSQL_PASSWORD": "<strong password>",
    "REDIS_PASSWORD": "",
    "AWS_ACCESS_KEY_ID": "",
    "AWS_SECRET_ACCESS_KEY": ""
  }'
```

Leave `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` empty — the ECS task IAM role handles S3 access automatically.

### Step 3 — Build and push Docker image

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

### Step 4 — Register ECS task definition

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
DB_HOST=$(aws cloudformation describe-stacks --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`DBEndpoint`].OutputValue' --output text)
REDIS_HOST=$(aws cloudformation describe-stacks --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`RedisEndpoint`].OutputValue' --output text)
EFS_ID=$(aws cloudformation describe-stacks --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`EFSFileSystemId`].OutputValue' --output text)

sed -e "s/<ACCOUNT_ID>/$ACCOUNT_ID/g" \
    -e "s/<REGION>/$REGION/g" \
    -e "s/<RDS_ENDPOINT>/$DB_HOST/g" \
    -e "s/<ELASTICACHE_PRIMARY_ENDPOINT>/$REDIS_HOST/g" \
    -e "s/<HOT_BUCKET_NAME>/<your-hot-bucket>/g" \
    -e "s/<COLD_BUCKET_NAME>/<your-cold-bucket>/g" \
    -e "s/<EFS_FILE_SYSTEM_ID>/$EFS_ID/g" \
    deploy/ecs-task-definition.json > /tmp/task-def-filled.json

aws ecs register-task-definition --cli-input-json file:///tmp/task-def-filled.json
```

### Step 5 — Deploy to ECS

```bash
CLUSTER=$(aws cloudformation describe-stacks --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`ECSClusterName`].OutputValue' --output text)
SERVICE=$(aws cloudformation describe-stacks --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`ECSServiceName`].OutputValue' --output text)

aws ecs update-service \
  --cluster $CLUSTER \
  --service $SERVICE \
  --force-new-deployment

aws ecs wait services-stable --cluster $CLUSTER --services $SERVICE
echo "Deployment complete"

# Get app URL (CloudFront domain)
aws cloudformation describe-stacks --stack-name cloudvault-prod \
  --query 'Stacks[0].Outputs[?OutputKey==`AppURL`].OutputValue' --output text
```

### Notes on EFS (shared cache)

- All ECS tasks mount the same EFS volume at `/usr/src/app/storage`
- A file cached by Task 1 is instantly available to Task 2 — no duplicate S3 fetches
- EFS uses elastic throughput (auto-scales with load)
- EFS IA lifecycle moves untouched cache files to Infrequent Access tier after 30 days (cost saving)
- `MAX_CACHE_SIZE_BYTES` is set to 100 GB in CloudFormation — EFS has no hard quota, it scales automatically

### Cost estimate (us-east-1, light load)

| Service | Config | Monthly |
|---|---|---|
| ECS Fargate | 0.5 vCPU, 1 GB, 1 task | ~$18 |
| RDS MySQL | db.t3.micro, 20 GB | ~$15 |
| ElastiCache Redis | cache.t3.micro | ~$12 |
| EFS | per-GB-stored + throughput | ~$5–20 |
| NAT Gateway | per-hour + data (S3 bypassed) | ~$35 |
| CloudFront | first 1 TB/mo free | ~$0 |
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
