const http = require('http');
const fs = require('fs');
const path = require('path');
const { boundary, request } = require('http');

const API_PORT = 3000;
const TEST_FILE_PATH = path.join(__dirname, 'test_file.txt');

// Ensure test file exists
if (!fs.existsSync(TEST_FILE_PATH)) {
    fs.writeFileSync(TEST_FILE_PATH, 'This is a test file for CloudVault Multipart Upload.');
}

const runTest = async () => {
    console.log("🚀 Starting CloudVault Multipart API Test...");

    // 1. Prepare Multipart Data
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const filePath = TEST_FILE_PATH;
    const fileName = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);

    // Construct Multipart Body
    let body = `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
    body += `Content-Type: text/plain\r\n\r\n`;
    body += fileContent;
    body += `\r\n--${boundary}--\r\n`;

    // 2. UPLOAD
    console.log("\n1️⃣  Testing Upload (Multipart)...");
    const uploadOptions = {
        hostname: 'localhost',
        port: API_PORT,
        path: '/api/files/upload',
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(body)
        }
    };

    const uploadReq = http.request(uploadOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            if (res.statusCode === 200 || res.statusCode === 201) {
                console.log("✅ Upload Success!");
                const response = JSON.parse(data);
                console.log("Response:", response);

                if (response.s3Key) {
                    downloadTest(response.s3Key);
                } else {
                    console.error("❌ No s3Key in response.");
                }
            } else {
                console.error(`❌ Upload Failed: Status ${res.statusCode}`);
                console.error("Body:", data);
            }
        });
    });

    uploadReq.on('error', (e) => console.error("❌ Upload Request Error:", e));
    uploadReq.write(body);
    uploadReq.end();
};

const downloadTest = (key) => {
    console.log(`\n2️⃣  Testing Download for Key: ${key}`);
    const downloadOptions = {
        hostname: 'localhost',
        port: API_PORT,
        path: `/api/files/download/${encodeURIComponent(key)}`,
        method: 'GET'
    };

    const downloadReq = http.request(downloadOptions, (res) => {
        if (res.statusCode === 200) {
            console.log("✅ Download Success!");
            // consume stream
            res.resume();
        } else {
            console.error(`❌ Download Failed: Status ${res.statusCode}`);
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => console.error("Error Body:", data));
        }
    });

    downloadReq.on('error', (e) => console.error("❌ Download Request Error:", e));
    downloadReq.end();
};

runTest();
