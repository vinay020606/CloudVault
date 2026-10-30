#!/bin/bash
# CloudVault — Production Deploy Script (Option C: ECS Fargate)
# Run once after filling in all <PLACEHOLDER> values below.
# Usage: bash deploy/scripts/deploy.sh

set -e

# ─────────────────────────────────────────────────────────────────────────────
# FILL IN THESE VALUES BEFORE RUNNING
# ─────────────────────────────────────────────────────────────────────────────

AWS_ACCOUNT_ID=""           # e.g. 123456789012
AWS_REGION=""               # e.g. us-east-1
APP_NAME="cloudvault"
ENVIRONMENT="production"

# S3 bucket names (must be globally unique)
HOT_BUCKET_NAME=""          # e.g. mycompany-cloudvault-hot
COLD_BUCKET_NAME=""         # e.g. mycompany-cloudvault-cold

# ACM Certificate ARN (optional — leave blank for HTTP only)
CERTIFICATE_ARN=""

# Image tag to deploy
IMAGE_TAG="latest"

# ─────────────────────────────────────────────────────────────────────────────
# VALIDATION
# ─────────────────────────────────────────────────────────────────────────────

if [ -z "$AWS_ACCOUNT_ID" ] || [ -z "$AWS_REGION" ] || [ -z "$HOT_BUCKET_NAME" ] || [ -z "$COLD_BUCKET_NAME" ]; then
  echo "ERROR: Fill in AWS_ACCOUNT_ID, AWS_REGION, HOT_BUCKET_NAME, and COLD_BUCKET_NAME before running."
  exit 1
fi

ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME"
STACK_NAME="$APP_NAME-$ENVIRONMENT"

echo "=== CloudVault Deploy: $STACK_NAME ==="
echo "Region:  $AWS_REGION"
echo "Account: $AWS_ACCOUNT_ID"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Deploy CloudFormation infrastructure stack
# ─────────────────────────────────────────────────────────────────────────────

echo "[1/5] Deploying CloudFormation stack: $STACK_NAME"

aws cloudformation deploy \
  --template-file deploy/cloudformation/infra.yml \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    AppName="$APP_NAME" \
    Environment="$ENVIRONMENT" \
    HotBucketName="$HOT_BUCKET_NAME" \
    ColdBucketName="$COLD_BUCKET_NAME" \
    CertificateArn="$CERTIFICATE_ARN" \
  --no-fail-on-empty-changeset

echo "[1/5] Infrastructure stack deployed."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Fill secrets in Secrets Manager
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "[2/5] Checking Secrets Manager..."
SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='SecretsManagerARN'].OutputValue" \
  --output text)

echo "Secret ARN: $SECRET_ARN"
echo ""
echo "  ACTION REQUIRED: Fill in the secret values before continuing."
echo "  Run this command and replace the empty strings with real values:"
echo ""
echo "  aws secretsmanager put-secret-value \\"
echo "    --secret-id \"$SECRET_ARN\" \\"
echo "    --secret-string '{"
echo "      \"JWT_SECRET\": \"<run: node -e 'console.log(require(crypto).randomBytes(64).toString(hex))'>\","
echo "      \"TOKEN_API_KEY\": \"<random string>\","
echo "      \"MYSQL_PASSWORD\": \"<strong password>\","
echo "      \"REDIS_PASSWORD\": \"\","
echo "      \"AWS_ACCESS_KEY_ID\": \"\","
echo "      \"AWS_SECRET_ACCESS_KEY\": \"\""
echo "    }'"
echo ""
read -p "Press ENTER after you have filled in the secrets to continue..."

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Build and push Docker image to ECR
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "[3/5] Building and pushing Docker image to ECR..."

aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$ECR_URI"

docker build -t "$APP_NAME:$IMAGE_TAG" .
docker tag "$APP_NAME:$IMAGE_TAG" "$ECR_URI:$IMAGE_TAG"
docker push "$ECR_URI:$IMAGE_TAG"

echo "[3/5] Image pushed: $ECR_URI:$IMAGE_TAG"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — Update ECS Task Definition with the new image URI
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "[4/5] Updating ECS task definition..."

# Replace placeholder with real image URI in task definition
sed "s|<ACCOUNT_ID>|$AWS_ACCOUNT_ID|g; s|<REGION>|$AWS_REGION|g" \
  deploy/ecs-task-definition.json > /tmp/cloudvault-task-def.json

# Get dynamic values from CloudFormation outputs
DB_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DBEndpoint'].OutputValue" --output text)

REDIS_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='RedisEndpoint'].OutputValue" --output text)

# Inject DB and Redis endpoints
sed -i \
  "s|<RDS_ENDPOINT>|$DB_ENDPOINT|g; \
   s|<ELASTICACHE_PRIMARY_ENDPOINT>|$REDIS_ENDPOINT|g; \
   s|<HOT_BUCKET_NAME>|$HOT_BUCKET_NAME|g; \
   s|<COLD_BUCKET_NAME>|$COLD_BUCKET_NAME|g" \
  /tmp/cloudvault-task-def.json

# Register new task definition revision
TASK_DEF_ARN=$(aws ecs register-task-definition \
  --region "$AWS_REGION" \
  --cli-input-json file:///tmp/cloudvault-task-def.json \
  --query "taskDefinition.taskDefinitionArn" \
  --output text)

echo "[4/5] Registered task definition: $TASK_DEF_ARN"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — Force ECS service to deploy new task definition
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "[5/5] Deploying new task definition to ECS service..."

CLUSTER_NAME=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ECSClusterName'].OutputValue" --output text)

SERVICE_NAME=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ECSServiceName'].OutputValue" --output text)

aws ecs update-service \
  --region "$AWS_REGION" \
  --cluster "$CLUSTER_NAME" \
  --service "$SERVICE_NAME" \
  --task-definition "$TASK_DEF_ARN" \
  --force-new-deployment \
  --query "service.serviceName" \
  --output text

echo ""
echo "[5/5] Deployment triggered. Waiting for service to stabilize..."
aws ecs wait services-stable \
  --region "$AWS_REGION" \
  --cluster "$CLUSTER_NAME" \
  --services "$SERVICE_NAME"

# ─────────────────────────────────────────────────────────────────────────────
# DONE
# ─────────────────────────────────────────────────────────────────────────────

APP_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AppURL'].OutputValue" --output text)

echo ""
echo "=== Deploy complete ==="
echo "URL:     $APP_URL"
echo "Health:  $APP_URL/health"
echo ""
