const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const upload = require('../middleware/upload');
const db = require('../db/database');
const queueService = require('../services/queueService');
const audioService = require('../services/audioService');
const { v4: uuidv4 } = require('uuid');
const { PROCESSED_DIR, stemWavPath } = require('../services/separatorPaths');
const { assertInsideDirectory } = require('../utils/fsUtils');

// Modo demo isolado (trackId reservado 'demo') — serve apenas os 4 arquivos
// de demonstração válidos de Moises_v2/server/processed/demo. Não interfere
// com nenhuma track real.
const DEMO_DIR = path.join(PROCESSED_DIR, 'demo');

function isStemName(stem) {
  return ['vocals', 'drums', 'bass', 'other'].includes(stem);
}

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

    const send = (eventType, payload) => {
      try {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        // cliente já desconectou
      }
    };

    // Estado inicial imediato (evita a UI ficar esperando o primeiro evento)
    send('status', { status: track.status, percent: track.status === 'COMPLETED' ? 100 : 0, message: track.status });

    // Se já terminou (concluído ou falhou), não há mais nada a esperar.
    if (track.status === 'COMPLETED' || track.status === 'FAILED') {
      return res.end();
    }

    // Heartbeat para proxies/load balancers não matarem a conexão
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    const listener = (payload) => {
      const eventType = payload.status === 'COMPLETED' ? 'completed'
        : payload.status === 'FAILED' ? 'failed'
        : 'progress';
      send(eventType, payload);
      if (payload.status === 'COMPLETED' || payload.status === 'FAILED') {
        clearInterval(heartbeat);
        queueService.progressEmitter.removeListener(track.id, listener);
        res.end();
      }
    };

    queueService.progressEmitter.on(track.id, listener);

    req.on('close', () => {
      clearInterval(heartbeat);
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
    if (req.params.id === 'demo') {
      return res.status(404).json({ error: 'Track não encontrada.' });
    }
    const track = await db.get('SELECT * FROM tracks WHERE id = ?', [req.params.id]);
    if (!track) return res.status(404).json({ error: 'Track não encontrada.' });

    res.json(track);
  } catch (error) {
    next(error);
  }
});

// 5. Listar Stems (vocals, drums, bass, other)
router.get('/tracks/:id/stems', async (req, res) => {
  try {
    const trackId = req.params.id;

    // Modo demo isolado
    if (trackId === 'demo') {
      return res.json({
        trackId: 'demo',
        demoMode: true,
        stems: audioService.STEM_NAMES.map((name) => ({
          stem: name,
          name: `${name}.wav`,
          url: `/processed/demo/${name}.wav`
        }))
      });
    }

    const track = await db.get(
      'SELECT * FROM tracks WHERE id = ?',
      [trackId]
    );

    if (!track) {
      return res.status(404).json({ error: 'Track não encontrada.' });
    }

    const stems = audioService.listStems(trackId);

    // Só lista stems de tracks COMPLETED; tracks em outro estado não
    // expõem arquivos inexistentes à UI.
    if (track.status !== 'COMPLETED') {
      return res.status(400).json({
        error: 'O processamento desta track ainda não foi concluído.',
        status: track.status,
        stems: []
      });
    }

    if (stems.length === 0) {
      return res.status(404).json({ error: 'Nenhum stem encontrado para esta track.' });
    }

    return res.json({
      trackId,
      stems
    });
  } catch (error) {
    console.error('Erro ao carregar stems:', error);

    return res.status(500).json({
      error: 'Erro interno ao carregar stems'
    });
  }
});

// 6. Streaming de um Stem Individual (necessário para o player Web Audio API)
router.get('/tracks/:id/stems/:stem', async (req, res, next) => {
  try {
    const stem = req.params.stem;
    if (!isStemName(stem)) {
      return res.status(404).json({ error: `Stem '${stem}' não encontrada.` });
    }

    // Modo demo isolado
    if (req.params.id === 'demo') {
      const filePath = assertInsideDirectory(
        path.join(DEMO_DIR, `${stem}.wav`),
        DEMO_DIR
      );
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: `Arquivo demo '${stem}.wav' não encontrado.` });
      }
      const stat = fs.statSync(filePath);
      res.set('Content-Type', 'audio/wav');
      res.set('Accept-Ranges', 'bytes');
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const track = await db.get('SELECT * FROM tracks WHERE id = ?', [req.params.id]);
    if (!track) return res.status(404).json({ error: 'Track não encontrada.' });
    if (track.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'O processamento desta track ainda não foi concluído.' });
    }

    // Caminho físico validado contra path traversal
    const filePath = assertInsideDirectory(
      stemWavPath(track.id, stem),
      PROCESSED_DIR
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `Stem '${stem}' não encontrada.` });
    }

    const stat = fs.statSync(filePath);
    res.set('Content-Type', 'audio/wav');
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Length', String(stat.size));
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
