const storageService = require('../services/storageService');

exports.uploadFile = async (req, res) => {
    try {
        await storageService.uploadFile(req, res);
    } catch (err) {
        console.error("Controller Upload Error:", err);
        res.status(500).json({ error: "Internal Server Error during upload" });
    }
};

exports.downloadFile = async (req, res) => {
    try {
        await storageService.downloadFile(req, res);
    } catch (err) {
        console.error("Controller Download Error:", err);
        res.status(500).json({ error: "Internal Server Error during download" });
    }
};
