const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const upload = require('../middleware/upload');
const db = require('../db/database');
const queueService = require('../services/queueService');
const audioService = require('../services/audioService');
const { v4: uuidv4 } = require('uuid');

// 1. Upload de Áudio
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const trackId = uuidv4();
    const originalName = req.file.originalname;
    const filename = req.file.filename;

    await db.run(
      'INSERT INTO tracks (id, original_name, filename, status) VALUES (?, ?, ?, ?)',
      [trackId, originalName, filename, 'PENDING']
    );

    // Adiciona na fila de separação do Demucs
    queueService.addJob(trackId, req.file.path);

    res.status(201).json({
      message: 'Arquivo recebido e adicionado à fila de processamento.',
      trackId,
      status: 'PENDING'
    });
  } catch (error) {
    next(error);
  }
});

// 2. Progresso em tempo real via SSE (usado pela barra de progresso da UI)
router.get('/tracks/:id/progress', async (req, res, next) => {
  try {
    const track = await db.get('SELECT * FROM tracks WHERE id = ?', [req.params.id]);
    if (!track) return res.status(404).json({ error: 'Track não encontrada.' });

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();

    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Estado inicial imediato (evita a UI ficar esperando o primeiro evento)
    send({ status: track.status, percent: track.status === 'COMPLETED' ? 100 : 0, message: track.status });

    // Se já terminou (concluído ou falhou), não há mais nada a esperar.
    if (track.status === 'COMPLETED' || track.status === 'FAILED') {
      return res.end();
    }

    const listener = (payload) => {
      send(payload);
      if (payload.status === 'COMPLETED' || payload.status === 'FAILED') {
        queueService.progressEmitter.removeListener(track.id, listener);
        res.end();
      }
    };

    queueService.progressEmitter.on(track.id, listener);

    req.on('close', () => {
      queueService.progressEmitter.removeListener(track.id, listener);
    });
  } catch (error) {
    next(error);
  }
});

// 3. Histórico de Tracks
router.get('/tracks', async (req, res, next) => {
  try {
    const tracks = await db.all('SELECT * FROM tracks ORDER BY created_at DESC');
    res.json(tracks);
  } catch (error) {
    next(error);
  }
});

// 4. Status de uma Track Específica
router.get('/tracks/:id', async (req, res, next) => {
  try {
    const track = await db.get('SELECT * FROM tracks WHERE id = ?', [req.params.id]);
    if (!track) return res.status(404).json({ error: 'Track não encontrada.' });
    
    res.json(track);
  } catch (error) {
    next(error);
  }
});

// 5. Listar Stems (vocals, drums, bass, other) de uma Track Concluída
router.get('/tracks/:id/stems', async (req, res, next) => {
  try {
    const track = await db.get('SELECT * FROM tracks WHERE id = ?', [req.params.id]);

    if (!track) return res.status(404).json({ error: 'Track não encontrada.' });
    if (track.status !== 'COMPLETED') return res.status(400).json({ error: 'O processamento desta track ainda não foi concluído.' });

    const stems = audioService.listStems(track.id);
    res.json({ trackId: track.id, stems });
  } catch (error) {
    next(error);
  }
});

// 6. Streaming de um Stem Individual (necessário para o player Web Audio API)
router.get('/tracks/:id/stems/:stem', async (req, res, next) => {
  try {
    const track = await db.get('SELECT * FROM tracks WHERE id = ?', [req.params.id]);

    if (!track) return res.status(404).json({ error: 'Track não encontrada.' });
    if (track.status !== 'COMPLETED') return res.status(400).json({ error: 'O processamento desta track ainda não foi concluído.' });

    const stems = audioService.listStems(track.id);
    const match = stems.find((s) => s.stem === req.params.stem);
    if (!match) return res.status(404).json({ error: `Stem '${req.params.stem}' não encontrada.` });

    const filePath = path.join(process.env.PROCESSED_DIR, track.id, match.name);
    res.set('Content-Type', 'audio/wav');
    res.set('Accept-Ranges', 'bytes');
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    next(error);
  }
});

// 7. Download do ZIP (Stems Separados)
router.get('/tracks/:id/download', async (req, res, next) => {
  try {
    const track = await db.get('SELECT * FROM tracks WHERE id = ?', [req.params.id]);
    
    if (!track) return res.status(404).json({ error: 'Track não encontrada.' });
    if (track.status !== 'COMPLETED') return res.status(400).json({ error: 'O processamento desta track ainda não foi concluído.' });

    res.attachment(`${track.original_name}_stems.zip`);
    await audioService.createZip(track.id, res);
  } catch (error) {
    next(error);
  }
});

module.exports = router;