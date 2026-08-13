/**
 * audioService.js
 * -----------------------------------------------------------------------
 * Serviço de processamento de áudio do Worship AI.
 *
 * Fluxo real:
 *   1. preprocessFile  → ffmpeg (ffmpeg-static) converte o upload para
 *                        WAV PCM 16 bits, mono, 44100 Hz (formato que o
 *                        modelo espera) em staged/tmp.
 *   2. processDemucs   → executa o modelo HT-Demucs via ONNX Runtime
 *                        (onnxruntime-node) e grava os 4 stems em WAV.
 *   3. validateStems   → só permite marcar a track como COMPLETED quando
 *                        todos os 4 stems existirem e forem WAVs válidos.
 *
 * Se o modelo não estiver disponível (primeira execução / download em
 * andamento), o processamento falha de forma honesta com status FAILED
 * e mensagem clara — nunca marca COMPLETED sem áudio real.
 * -----------------------------------------------------------------------
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const logger = require('../middleware/logger');
const { stemWavPath, PROCESSED_DIR } = require('./separatorPaths');

ffmpeg.setFfmpegPath(ffmpegPath);

const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];

// ---------------------------------------------------------------
// Preprocessamento: converte o upload para WAV PCM 16b/mono/44100Hz
// ---------------------------------------------------------------
async function preprocessFile(inputPath, trackId, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const normalized = path.join(tmpDir, `${trackId}_normalized.wav`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFrequency(44100)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => resolve(normalized))
      .on('error', (err) => reject(new Error(`Falha ao converter o áudio: ${err.message}`)))
      .save(normalized);
  });
}

// ---------------------------------------------------------------
// Validação de stems: WAV válido e não vazio
// ---------------------------------------------------------------
function validateWavHeader(buffer) {
  if (buffer.length < 44) return false;
  const riff = buffer.toString('ascii', 0, 4);
  const wave = buffer.toString('ascii', 8, 12);
  const dataTag = buffer.toString('ascii', 36, 40);
  if (riff !== 'RIFF' || wave !== 'WAVE' || dataTag !== 'data') return false;

  const dataSize = buffer.readUInt32LE(40);
  return dataSize > 0;
}

async function validateStems(trackId) {
  const results = [];
  for (const stem of STEM_NAMES) {
    const filePath = stemWavPath(trackId, stem);
    let valid = false;
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size < 44) {
        valid = false;
      } else {
        const header = Buffer.alloc(44);
        const fh = await fsp.open(filePath, 'r');
        try {
          await fh.read(header, 0, 44, 0);
        } finally {
          await fh.close();
        }
        valid = validateWavHeader(header);
      }
    } catch (err) {
      valid = false;
    }
    results.push({ stem, valid });
  }
  return results;
}

// ---------------------------------------------------------------
// ZIP com os 4 stems (rota /tracks/:id/download)
// ---------------------------------------------------------------
async function createZip(trackId, res) {
  const archiver = require('archiver');
  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('error', (err) => { throw err; });
  archive.pipe(res);

  for (const stem of STEM_NAMES) {
    const filePath = stemWavPath(trackId, stem);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: `${stem}.wav` });
    }
  }

  // finalize resolve quando o ZIP está escrito no buffer do archiver, mas a
  // resposta ainda pode estar escrevendo no socket. Aguardar o 'finish' do
  // res para garantir o fim completo da transferência.
  await archive.finalize();
  await new Promise((resolve) => {
    if (res.writableFinished) return resolve();
    res.on('finish', resolve);
    res.on('error', resolve);
  });
}

// ---------------------------------------------------------------
// Interface pública
// ---------------------------------------------------------------
async function processDemucs(inputPath, trackId, progressCb) {
  if (typeof progressCb !== 'function') {
    progressCb = () => {};
  }

  const outDir = path.join(PROCESSED_DIR, trackId);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = path.join(outDir, '_tmp');

  progressCb(5, 'Preparando áudio...');
  const normalized = await preprocessFile(inputPath, trackId, tmpDir);
  progressCb(20, 'Áudio normalizado. Separando stems...');
  progressCb(25, 'Separando stems...');

  // Separador real (ONNX) — pode lançar erro se indisponível
  const { separateFile } = require('./separateOnnx');
  await separateFile(normalized, outDir, (fraction) => {
    // fraction: 0 → 1 dentro da separação; barra total: 25% → 95%
    progressCb(25 + Math.round(fraction * 70), 'Separando stems...');
  });

  progressCb(95, 'Gerando arquivos WAV...');

  // Validação obrigatória antes de considerar concluído
  const validation = await validateStems(trackId);
  const invalid = validation.filter((r) => !r.valid);
  if (invalid.length > 0) {
    throw new Error(
      `Stems inválidos após a separação: ${invalid.map((r) => r.stem).join(', ')}.`
    );
  }

  // Limpa os temporários de processamento
  try {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(`Falha ao limpar temporários da track ${trackId}: ${err.message}`);
  }

  progressCb(100, 'Concluído');
  return { success: true, demoMode: false };
}

function listStems(trackId) {
  const stemsDir = path.join(PROCESSED_DIR, trackId);
  if (!fs.existsSync(stemsDir)) return [];

  return STEM_NAMES.map((stem) => {
    const filename = `${stem}.wav`;
    const filePath = path.join(stemsDir, filename);
    if (!fs.existsSync(filePath)) return null;
    return { stem, name: filename, url: `/processed/${trackId}/${filename}` };
  }).filter(Boolean);
}

module.exports = {
  processDemucs,
  listStems,
  validateStems,
  validateWavHeader,
  createZip,
  STEM_NAMES,
};
