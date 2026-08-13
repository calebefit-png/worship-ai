/**
 * separatorPaths.js
 * -----------------------------------------------------------------------
 * Contrato único de caminhos de armazenamento para stems processados.
 * Centraliza PROCESSED_DIR e a função stemWavPath para que todas as
 * rotas, serviços e o separador usem exatamente o mesmo diretório,
 * eliminando divergências de __dirname vs env.
 * -----------------------------------------------------------------------
 */

const path = require('path');

const PROCESSED_DIR = process.env.PROCESSED_DIR
  ? path.resolve(process.env.PROCESSED_DIR)
  : path.resolve(__dirname, '..', 'processed');

function stemWavPath(trackId, stem) {
  return path.join(PROCESSED_DIR, trackId, `${stem}.wav`);
}

module.exports = { PROCESSED_DIR, stemWavPath };
