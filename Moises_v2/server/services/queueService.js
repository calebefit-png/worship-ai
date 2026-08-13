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

    await db.run(
      'UPDATE tracks SET status = ?, processing_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['PROCESSING', task.id]
    );
    emitProgress(task.id, { status: 'PROCESSING', percent: 0, message: 'Iniciando processamento...' });

    // Assinatura correta: processDemucs(inputPath, trackId, progressCb)
    const progressCb = (percent, message) => {
      emitProgress(task.id, {
        status: 'PROCESSING',
        percent: Math.min(99, percent || 0),
        message: message || 'Processando...',
      });
    };

    await audioService.processDemucs(task.filepath, task.id, progressCb);

    // Validação obrigatória: só marca COMPLETED se os 4 stems forem
    // WAVs reais, não vazios e com cabeçalho válido.
    const validation = await audioService.validateStems(task.id);
    const invalid = validation.filter((r) => !r.valid);
    if (invalid.length > 0) {
      throw new Error(
        `Stems inválidos após o processamento: ${invalid.map((r) => r.stem).join(', ')}.`
      );
    }

    await db.run(
      'UPDATE tracks SET status = ?, processing_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['COMPLETED', task.id]
    );
    emitProgress(task.id, { status: 'COMPLETED', percent: 100, message: 'Concluído.' });
    logger.info(`Track ${task.id} finalizada com sucesso.`);
  } catch (error) {
    logger.error(`Falha ao processar track ${task.id}: ${error.message}`);
    await db.run(
      'UPDATE tracks SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['FAILED', error.message || 'Erro desconhecido no processamento.', task.id]
    );
    emitProgress(task.id, {
      status: 'FAILED',
      percent: 0,
      message: error.message || 'Erro no processamento.',
    });
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
