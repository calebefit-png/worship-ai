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

const app = express();
const PORT = process.env.PORT || 3000;

// Garantir que as pastas existam
ensureDirectories();

// Inicializar banco de dados
db.initDb();

// Segurança e middlewares
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// SERVIR ARQUIVOS WAV PROCESSADOS
// Pasta: Moises_v2/server/processed
// =====================================================
app.use('/processed', express.static(path.join(__dirname, 'processed')));

// =====================================================
// SERVIR O FRONTEND
// Pasta: Moises_v2/public
// =====================================================
app.use(express.static(path.join(__dirname, '..', 'public')));

// Página inicial
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// =====================================================
// TESTE DIRETO DO ARQUIVO DEMO
// Abra: https://worship-ai-node.onrender.com/demo-test
// =====================================================
app.get('/demo-test', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'processed', 'demo', 'vocals.wav')
  );
});

// Rotas da API
app.use('/api/v1/audio', audioRoutes);

// Tratamento global de erros
app.use(errorHandler);

// Iniciar servidor
app.listen(PORT, () => {
  logger.info(
    `Servidor rodando na porta ${PORT} no modo ${process.env.NODE_ENV}`
  );
});
