const redis = require('redis');
require('dotenv').config();

const client = redis.createClient({
    url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
});

client.on('error', (err) => console.log('❌ Redis Error:', err));

const connectRedis = async () => {
    try {
        await client.connect();
        console.log("✅ Redis Connected");
    } catch (err) {
        console.error("❌ Redis Connection Failed:", err.message);
    }
};

module.exports = { client, connectRedis };