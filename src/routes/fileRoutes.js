const express = require('express');
const router = express.Router();
const multer = require('multer');
const { uploadFile, downloadFile } = require('../services/storageService');
const { Readable } = require('stream');

// Multer config: Do NOT save to disk. Keep in RAM for streaming.
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/files/upload
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send("No file uploaded");

        // Convert Buffer to Stream
        const fileStream = Readable.from(req.file.buffer);

        const result = await uploadFile(
            fileStream,
            req.file.originalname,
            req.file.mimetype,
            req.file.size
        );

        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/files/download/:key
router.get('/download/:key', async (req, res) => {
    try {
        const bypassCache = req.query.nocache === 'true';
        await downloadFile(req.params.key, res, bypassCache);
    } catch (err) {
        console.error(err);
        res.status(500).send("Download failed");
    }
});

module.exports = router;