const fs = require('fs');
const path = require('path');
const logger = require('../middleware/logger');

const ensureDirectories = () => {
  const dirs = [
    process.env.UPLOAD_DIR || 'uploads',
    process.env.PROCESSED_DIR || 'processed',
    'logs'
  ];
  dirs.forEach(dir => {
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

module.exports = { ensureDirectories };