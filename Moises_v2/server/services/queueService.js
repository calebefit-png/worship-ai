const { EventEmitter } = require('events');
const db = require('../db/database');
const audioService = require('./audioService');
const logger = require('../middleware/logger');

// Fila em memória simples
const queue = [];
let isProcessing = false;

// Emissor de eventos de progresso — usado pela rota SSE /tracks/:id/progress
const progressEmitter = new EventEmitter();
progressEmitter.setMaxListeners(50);

const emitProgress = (trackId, payload) => {
  progressEmitter.emit(trackId, payload);
};

const processQueue = async () => {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  const task = queue.shift();

  try {
    logger.info(`Processando track: ${task.id}`);
    await db.run('UPDATE tracks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['PROCESSING', task.id]);
    emitProgress(task.id, { status: 'PROCESSING', percent: 0, message: 'Iniciando separação...' });

    await audioService.processDemucs(task.id, task.filepath, (percent, message) => {
      emitProgress(task.id, { status: 'PROCESSING', percent, message });
    });

    await db.run('UPDATE tracks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['COMPLETED', task.id]);
    emitProgress(task.id, { status: 'COMPLETED', percent: 100, message: 'Concluído.' });
    logger.info(`Track ${task.id} finalizada.`);
  } catch (error) {
    logger.error(`Falha ao processar track ${task.id}: ${error.message}`);
    await db.run('UPDATE tracks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['FAILED', task.id]);
    emitProgress(task.id, { status: 'FAILED', percent: 0, message: error.message || 'Erro no processamento.' });
  } finally {
    isProcessing = false;
    processQueue(); // Puxa o próximo da fila
  }
};

const addJob = (id, filepath) => {
  queue.push({ id, filepath });
  emitProgress(id, { status: 'PENDING', percent: 0, message: 'Na fila...' });
  processQueue();
};

module.exports = { addJob, progressEmitter };