require('dotenv').config();
const express = require('express');
const { initDB } = require('./src/config/db');
const { connectRedis } = require('./src/config/redis');
const { startPolling } = require('./src/services/sqsService'); // [NEW] Import SQS Listener
const fileRoutes = require('./src/routes/fileRoutes');

const app = express();

// Middleware
app.use(express.json());

// Serve Static Files (The Frontend Dashboard)
// Note: If you have an index.html in /public, this will show up at localhost:3000
app.use(express.static('public'));

// Routes
app.use('/api/files', fileRoutes);

// Health Check (Renamed to /health so it doesn't conflict with dashboard)
app.get('/health', (req, res) => res.send("CloudVault Gateway is Online"));

const startServer = async () => {
    // 1. Connect to Infrastructure
    await initDB();       // Connect Postgres
    await connectRedis(); // Connect Redis
    
    // 2. Start the Event Listener [NEW]
    // This runs in the background watching for S3 updates
    startPolling(); 

    const PORT = process.env.PORT || 3000;

    // Listen on 0.0.0.0 to avoid Windows localhost issues
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
};

startServer();