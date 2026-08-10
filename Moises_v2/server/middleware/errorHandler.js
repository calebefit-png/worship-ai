const logger = require('./logger');

const errorHandler = (err, req, res, next) => {
  logger.error(`${err.message} - ${req.originalUrl} - ${req.method} - ${req.ip}`);

  if (err.message.includes('Formato de arquivo inválido') || err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Erro de validação de arquivo', details: err.message });
  }

  res.status(500).json({
    error: 'Erro interno do servidor',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
};

module.exports = errorHandler;