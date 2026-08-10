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

// Middlewares Globais de Segurança e Configuração
// CSP padrão do helmet bloqueia conexões/recursos não explicitamente
// declarados (incluindo EventSource do SSE de progresso); desativado aqui
// pois é uma aplicação local self-contained sem recursos de terceiros.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rotas
app.use('/api/v1/audio', audioRoutes);

// Tratamento de Erros Global
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`Servidor rodando na porta ${PORT} no modo ${process.env.NODE_ENV}`);
});