const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const fs = require('fs');
const path = require('path');
const { client: redisClient } = require('../config/redis');
require('dotenv').config();

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Initialize SQS Client
const sqsClient = new SQSClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

const startPolling = async () => {
    console.log("📡 Listening for S3 Updates via SQS...");

    const poll = async () => {
        try {
            const command = new ReceiveMessageCommand({
                QueueUrl: process.env.AWS_SQS_QUEUE_URL,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: 20, // Long Polling (Efficient)
            });

            const response = await sqsClient.send(command);

            if (response.Messages) {
                for (const message of response.Messages) {
                    await processMessage(message);
                }
            }
        } catch (err) {
            console.error("SQS Error:", err.message);
        }
        
        // Loop forever
        setImmediate(poll);
    };

    poll();
};

const processMessage = async (message) => {
    try {
        const body = JSON.parse(message.Body);
        
        // S3 sends a "Test Event" first, ignore it
        if (body.Event === "s3:TestEvent") return;

        // Ensure Records exist
        if (!body.Records) return;

        for (const record of body.Records) {
            const s3Key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
            const eventName = record.eventName;

            console.log(`🔔 S3 Event: ${eventName} -> ${s3Key}`);

            // If file was updated or deleted in S3 -> NUKE IT locally
            if (eventName.includes("ObjectCreated") || eventName.includes("ObjectRemoved")) {
                await invalidateCache(s3Key);
            }
        }

        // Delete message from Queue so we don't process it again
        await sqsClient.send(new DeleteMessageCommand({
            QueueUrl: process.env.AWS_SQS_QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle
        }));

    } catch (err) {
        console.error("Processing Error:", err);
    }
};

const invalidateCache = async (key) => {
    const localPath = path.join(UPLOADS_DIR, key);

    // 1. Delete from Disk
    if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        console.log(`🗑️ STALE DATA DELETED: ${key}`);
    } else {
        console.log(`ℹ️ File not in local cache, no action needed: ${key}`);
    }

    // 2. Delete from Redis
    await redisClient.del(`cache:${key}`);
    await redisClient.zRem('lru_index', key);
};

module.exports = { startPolling };