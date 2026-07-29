const { S3Client, ListBucketsCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
require('dotenv').config();

console.log("🔍 Diagnosing AWS S3 Connection...");
console.log(`- AWS_REGION: ${process.env.AWS_REGION}`);
console.log(`- AWS_ACCESS_KEY_ID: ${process.env.AWS_ACCESS_KEY_ID ? '******' + process.env.AWS_ACCESS_KEY_ID.slice(-4) : 'MISSING'}`);
console.log(`- AWS_SECRET_ACCESS_KEY: ${process.env.AWS_SECRET_ACCESS_KEY ? '******' : 'MISSING'}`);
console.log(`- AWS_BUCKET_NAME: ${process.env.AWS_BUCKET_NAME}`);

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const runDiagnosis = async () => {
    // 1. Check ListBuckets (might fail with 403)
    try {
        console.log("\n[TEST 1] ListBuckets (Global Permissions)...");
        const list = await s3Client.send(new ListBucketsCommand({}));
        console.log("✅ Success! Found", list.Buckets?.length, "buckets.");
    } catch (err) {
        console.log("⚠️  ListBuckets Failed (This is OK if you have restricted permissions):");
        console.log(`   Error: ${err.name} - ${err.message}`);
    }

    // 2. Check Specific Bucket Access & Region
    const bucketName = process.env.AWS_BUCKET_NAME;
    if (bucketName) {
        try {
            console.log(`\n[TEST 2] HeadBucket (Access to '${bucketName}')...`);
            await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
            console.log(`✅ Success! Bucket '${bucketName}' is accessible.`);
        } catch (err) {
            if (err.$metadata?.httpStatusCode === 301) {
                console.error(`❌ WRONG REGION: Bucket '${bucketName}' is NOT in '${process.env.AWS_REGION}'.`);
                // Attempt to find the correct region (requires s3:GetBucketLocation)
                try {
                    const { GetBucketLocationCommand } = require("@aws-sdk/client-s3");
                    // Sometimes finding region works from us-east-1
                    const regionClient = new S3Client({
                        region: 'us-east-1',
                        credentials: s3Client.config.credentials
                    });
                    const loc = await regionClient.send(new GetBucketLocationCommand({ Bucket: bucketName }));
                    console.error(`💡 FOUND IT! The bucket is in: '${loc.LocationConstraint || 'us-east-1'}'`);
                    console.error("👉 Please update AWS_REGION in your .env file.");
                } catch (locErr) {
                    console.error("Could not auto-detect region. Check AWS Console.");
                }
            } else {
                console.error(`❌ HeadBucket Failed for '${bucketName}':`);
                console.error(`   Error: ${err.name} - ${err.message}`);
                if (err.$metadata) console.error(`   Status Code: ${err.$metadata.httpStatusCode}`);
            }
        }
    } else {
        console.error("\n❌ AWS_BUCKET_NAME is not set in .env!");
    }
};

runDiagnosis();
