const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { Upload } = require("@aws-sdk/lib-storage");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { s3Client } = require('../config/s3');
const { client: redisClient } = require('../config/redis');
const { pool } = require('../config/db');
const { checkAndEvict } = require('./evictionService');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

/**
 * UPLOAD: Streams to S3 and Local Disk in Parallel
 */
const uploadFile = async (fileStream, filename, mimeType, size) => {
    // 1. Check if we need to clean up space first
    await checkAndEvict(size);

    const s3Key = `${Date.now()}-${filename}`;
    const localPath = path.join(UPLOADS_DIR, s3Key);

    // 2. Create Pipes
    const cloudStream = new PassThrough();
    const diskStream = new PassThrough();

    // 3. Pipe to Disk
    const writeStream = fs.createWriteStream(localPath);
    diskStream.pipe(writeStream);

    // 4. Pipe to S3
    const parallelUpload = new Upload({
        client: s3Client,
        params: {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: s3Key,
            Body: cloudStream,
            ContentType: mimeType,
        },
    });

    // 5. Start Data Flow
    fileStream.pipe(cloudStream);
    fileStream.pipe(diskStream);

    // Wait for S3 to finish
    await parallelUpload.done();

    // 6. Save Metadata to DB & Redis
    await pool.query(
        "INSERT INTO files (filename, s3_key, size, mime_type) VALUES ($1, $2, $3, $4)",
        [filename, s3Key, size, mimeType]
    );

    // Cache Index: "We have this file locally"
    await redisClient.set(`cache:${s3Key}`, 'HIT');
    // LRU Tracker: Score = Current Timestamp
    await redisClient.zAdd('lru_index', { score: Date.now(), value: s3Key });

    return { s3Key, status: "Stored in Cloud & Cache" };
};

/**
 * DOWNLOAD: Checks Cache First -> Then S3
 */
const downloadFile = async (s3Key, res, bypassCache = false) => {
    const localPath = path.join(UPLOADS_DIR, s3Key);

    // 0. Check Forced Bypass
    if (bypassCache) {
        console.log("⏩ FORCE BYPASS: Skipping Cache Check...");
    } else {
        // 1. Check Redis Cache
        const isCached = await redisClient.get(`cache:${s3Key}`);

        if (isCached && fs.existsSync(localPath)) {
            console.log("🚀 CACHE HIT: Serving from NVMe/Disk");

            // Update Timestamp (So it doesn't get deleted soon)
            await redisClient.zAdd('lru_index', { score: Date.now(), value: s3Key });

            res.setHeader('X-Cache', 'HIT');
            return fs.createReadStream(localPath).pipe(res);
        }
    }

    // 2. CACHE MISS (or Bypassed): Fetch from S3
    console.log("☁️ CACHE MISS (or BYPASSED): Fetching from AWS S3...");

    try {
        const command = new GetObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: s3Key
        });
        const { Body } = await s3Client.send(command);

        // 3. Save to Disk (Replenish Cache) + Send to User
        const saveToDisk = fs.createWriteStream(localPath);

        // AWS SDK v3 returns a stream in 'Body'
        if (bypassCache) {
            // If bypassing cache, we might NOT want to replenish it on disk, 
            // OR we might want to anyway. Usually if just testing S3 speed, we might leave disk alone
            // but logic here implies "Write-Through" on miss. 
            // To properly test "Clean Miss", we should overwrite or just stream.
            // Let's stick to standard behavior: Stream to user + disk.
            res.setHeader('X-Cache', 'MISS');
        }

        Body.pipe(saveToDisk);
        Body.pipe(res);

        saveToDisk.on('finish', async () => {
            console.log("✅ Cache Replenished");
            await redisClient.set(`cache:${s3Key}`, 'HIT');
            await redisClient.zAdd('lru_index', { score: Date.now(), value: s3Key });
        });

    } catch (err) {
        console.error("S3 Error for Key:", s3Key, "Bucket:", process.env.AWS_BUCKET_NAME);
        console.error("Original Error:", err);
        if (!res.headersSent) res.status(500).json({
            error: "File not found in S3",
            key: s3Key,
            bucket: process.env.AWS_BUCKET_NAME,
            details: err.message
        });
    }
};

module.exports = { uploadFile, downloadFile };