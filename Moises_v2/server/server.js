require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');

const { ensureDirectories } = require('./utils/fsUtils');
const logger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');
const audioRoutes = require('./routes/audioRoutes');
const db = require('./db/database');
const { PROCESSED_DIR } = require('./services/separatorPaths');

const app = express();
const PORT = process.env.PORT || 3000;
// Identificador explícito para diagnosticar o deploy sem expor dados sensíveis.
const RELEASE_ID = process.env.RELEASE_ID || 'int8-memory-fix-20260814';

// Garantir que as pastas existam
ensureDirectories();

// Inicializar banco de dados (schema síncrono). As migrações de colunas
// ficam expostas em db.initDb.migrationsReady e são aguardadas abaixo.
db.initDb();

// Segurança e middlewares
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// SERVIR ARQUIVOS WAV PROCESSADOS
// Pasta apontada por PROCESSED_DIR (path absoluto)
// =====================================================
app.use('/processed', express.static(PROCESSED_DIR));

// =====================================================
// SERVIR O FRONTEND
// Pasta: Moises_v2/public
// =====================================================
app.use(express.static(path.join(__dirname, '..', 'public')));

// Página inicial
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Health check (usado pelo Render para monitorar o serviço)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', release: RELEASE_ID, timestamp: new Date().toISOString() });
});

// Rotas da API
app.use('/api/v1/audio', audioRoutes);

// Tratamento global de erros
app.use(errorHandler);

// =====================================================
// BOOT: aguarda as migrações do SQLite antes do listen
// (evita "no such column" em escritas imediatas pós-boot).
// Envolvido em async IIFE — await top-level em .js faria
// o Node 22 interpretar o arquivo como ESM, quebrando os
// require() do restante do código.
// =====================================================
(async () => {
  await db.initDb.migrationsReady;
  app.listen(PORT, () => {
    logger.info(
      `Servidor rodando na porta ${PORT} no modo ${process.env.NODE_ENV || 'development'}`
    );
  });
})().catch((err) => {
  logger.error('Falha fatal ao iniciar o servidor', err);
  process.exit(1);
});
