const { S3Client } = require("@aws-sdk/client-s3");
require('dotenv').config();

// Initialize the S3 Client with your .env credentials
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

console.log(`[S3 Config] Initialized with Region: ${process.env.AWS_REGION}`);
console.log(`[S3 Config] Access Key ID Length: ${process.env.AWS_ACCESS_KEY_ID ? process.env.AWS_ACCESS_KEY_ID.length : 'MISSING'}`);
console.log(`[S3 Config] Secret Access Key: ${process.env.AWS_SECRET_ACCESS_KEY ? 'PRESENT' : 'MISSING'}`);
console.log(`[S3 Config] Bucket Name: ${process.env.AWS_BUCKET_NAME}`);

module.exports = { s3Client };