const fs = require('fs');
const path = require('path');
const { client: redisClient } = require('../config/redis');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100 MB Limit (Adjust as needed)

const checkAndEvict = async (incomingFileSize) => {
    // 1. Calculate Current Disk Usage
    const files = fs.readdirSync(UPLOADS_DIR);
    let currentUsage = 0;
    files.forEach(file => {
        currentUsage += fs.statSync(path.join(UPLOADS_DIR, file)).size;
    });

    console.log(`📊 Current Cache Usage: ${(currentUsage / 1024 / 1024).toFixed(2)} MB`);

    // 2. If adding this new file exceeds limit -> Evict old files
    while (currentUsage + incomingFileSize > MAX_CACHE_SIZE) {

        // Get the OLDEST file (Lowest Score) from Redis
        // zRange(key, start, stop) -> returns array
        const oldestFiles = await redisClient.zRange('lru_index', 0, 0);

        if (oldestFiles.length === 0) break; // Should not happen if files exist

        const victimKey = oldestFiles[0];
        const victimPath = path.join(UPLOADS_DIR, victimKey);

        // 3. Delete from Disk
        if (fs.existsSync(victimPath)) {
            const stats = fs.statSync(victimPath);
            currentUsage -= stats.size;
            fs.unlinkSync(victimPath);
            console.log(`🗑️ EVICTED: ${victimKey} (Freed ${stats.size} bytes)`);
        }

        // 4. Delete from Redis Index
        await redisClient.del(`cache:${victimKey}`);
        await redisClient.zRem('lru_index', victimKey);
    }
};

module.exports = { checkAndEvict };
