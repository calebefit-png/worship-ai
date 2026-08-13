const fs = require('fs');
const path = require('path');
const logger = require('../middleware/logger');
const { PROCESSED_DIR } = require('../services/separatorPaths');

const ensureDirectories = () => {
  const dirs = [
    path.resolve(process.env.UPLOAD_DIR || 'uploads'),
    PROCESSED_DIR,
    path.resolve('logs')
  ];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

/**
 * Valida se um caminho absoluto está dentro do diretório permitido,
 * prevenindo path traversal (ex.: ../../etc/passwd).
 */
function assertInsideDirectory(candidatePath, allowedRoot) {
  const resolved = path.resolve(candidatePath);
  const root = path.resolve(allowedRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error('Acesso fora do diretório permitido.');
  }
  return resolved;
}

module.exports = { ensureDirectories, assertInsideDirectory };
