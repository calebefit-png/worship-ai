const sqlite3 = require('sqlite3').verbose();
const path = require('path');
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