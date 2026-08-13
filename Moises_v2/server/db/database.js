const sqlite3 = require('sqlite3').verbose();
const logger = require('../middleware/logger');

const dbPath = process.env.DB_PATH || 'database.sqlite';
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) logger.error('Erro ao conectar ao banco SQLite', err);
  else logger.info('Conectado ao banco SQLite');
});

const initDb = () => {
  db.run(`
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      original_name TEXT,
      filename TEXT,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrações compatíveis: adiciona campos de diagnóstico se não existirem.
  // Verifica explicitamente via PRAGMA table_info antes do ALTER — alguns
  // builds do sqlite3 silenciam erros de execução e o callback nunca resolve/
  // rejeita, o que deixava o app com colunas faltando em boots rápidos.
  const addColumnIfMissing = (name, type) =>
    new Promise((resolve) => {
      db.all('PRAGMA table_info(tracks)', (err, cols) => {
        if (err) {
          logger.error('Falha ao inspecionar schema do banco', err);
          resolve();
          return;
        }
        const exists = (cols || []).some((c) => c.name === name);
        if (exists) {
          resolve();
          return;
        }
        db.run(`ALTER TABLE tracks ADD COLUMN ${name} ${type}`, (aErr) => {
          if (aErr) logger.error(`Migração falhou para coluna '${name}'`, aErr);
          resolve();
        });
      });
    });

  // Promessa de migrações exposta para o servidor aguardar antes de aceitar
  // escritas (evita SQLITE_ERROR "no such column" em escritas imediatas).
  initDb.migrationsReady = Promise.all([
    addColumnIfMissing('error_message', 'TEXT'),
    addColumnIfMissing('processing_started_at', 'DATETIME'),
    addColumnIfMissing('processing_completed_at', 'DATETIME'),
  ])
    .then(() => logger.info('Migrações do banco aplicadas (ou já existentes).'))
    .catch((err) => {
      logger.error('Falha ao aplicar migrações do banco', err);
      throw err;
    });
};

// Wrappers baseados em Promises para facilitar o uso no Express/Services
const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const all = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

module.exports = { db, initDb, run, get, all };
