#!/bin/bash
# Runs inside LocalStack container on startup — creates S3 buckets for demo

echo "[LocalStack Init] Creating CloudVault S3 demo buckets..."

awslocal s3 mb s3://cloudvault-hot  --region us-east-1
awslocal s3 mb s3://cloudvault-cold --region us-east-1

awslocal s3api put-bucket-versioning \
  --bucket cloudvault-hot \
  --versioning-configuration Status=Enabled

echo "[LocalStack Init] Buckets ready:"
awslocal s3 ls
