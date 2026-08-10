const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const logger = require('../middleware/logger');

ffmpeg.setFfmpegPath(ffmpegPath);

class AudioService {
  /**
   * Roda o Demucs completo (4 stems: vocals, drums, bass, other).
   * Requer Python + `pip install demucs` + ffmpeg no PATH.
   * Assinatura (trackId, inputPath, onProgress) — onProgress(percent, message)
   * é chamado conforme o Demucs reporta progresso no stderr, e é usado pelo
   * queueService para alimentar o SSE de progresso em tempo real.
   *
   * O Demucs sempre grava em outDir/htdemucs/{nome_do_arquivo}/*.wav.
   * Movemos os 4 stems para a raiz de outDir porque createZip() e o
   * restante do sistema esperam os arquivos ali direto, sem subpastas.
   */
  async processDemucs(trackId, inputPath, onProgress) {
    const outDir = path.join(process.env.PROCESSED_DIR, trackId);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    return new Promise((resolve, reject) => {
      const args = ['-o', outDir, inputPath];
      logger.info(`Iniciando Demucs (4 stems) para ${trackId}: demucs ${args.join(' ')}`);

      const proc = spawn('demucs', args);
      let stderrBuffer = '';
      let settled = false;

      // Demucs imprime progresso no stderr no formato: " 45%|####      | 12/27"
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrBuffer += text;
        const match = text.match(/(\d{1,3})%\|/);
        if (match && onProgress) {
          const percent = Math.min(99, parseInt(match[1], 10));
          onProgress(percent, `Separando faixas... ${percent}%`);
        }
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        logger.error(`Falha ao iniciar processo Demucs: ${err.message}`);
        reject(new Error('Não foi possível executar o Demucs. Verifique se está instalado (pip install demucs) e disponível no PATH.'));
      });

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;

        if (code !== 0) {
          logger.error(`Demucs finalizou com código ${code}: ${stderrBuffer.slice(-2000)}`);
          return reject(new Error(`Demucs finalizou com erro (código ${code}).`));
        }

        const songName = path.parse(inputPath).name;
        const demucsDir = path.join(outDir, 'htdemucs', songName);
        const stemNames = ['vocals.wav', 'drums.wav', 'bass.wav', 'other.wav'];

        for (const name of stemNames) {
          const srcPath = path.join(demucsDir, name);
          if (!fs.existsSync(srcPath)) {
            return reject(new Error(`Stem não encontrada após o Demucs rodar: ${name} (esperada em ${srcPath})`));
          }
        }

        // Move os stems reais para a raiz de outDir (contrato esperado por createZip e pela API)
        for (const name of stemNames) {
          fs.renameSync(path.join(demucsDir, name), path.join(outDir, name));
        }

        // Limpa a subpasta vazia do Demucs
        try {
          fs.rmSync(path.join(outDir, 'htdemucs'), { recursive: true, force: true });
        } catch (e) { /* não crítico */ }

        logger.info(`Demucs concluído para ${trackId} (4 stems)`);
        resolve(outDir);
      });
    });
  }

  /**
   * Lista os stems disponíveis (nome + tamanho em bytes) para uma track já
   * concluída. Usado pelo endpoint GET /tracks/:id/stems.
   */
  listStems(trackId) {
    const dir = path.join(process.env.PROCESSED_DIR, trackId);
    const stemNames = ['vocals.wav', 'drums.wav', 'bass.wav', 'other.wav'];

    return stemNames
      .map((name) => {
        const filePath = path.join(dir, name);
        if (!fs.existsSync(filePath)) return null;
        return {
          name,
          stem: path.parse(name).name, // vocals, drums, bass, other
          sizeBytes: fs.statSync(filePath).size,
        };
      })
      .filter(Boolean);
  }

  async createZip(trackId, res) {
    const sourceDir = path.join(process.env.PROCESSED_DIR, trackId);
    
    if (!fs.existsSync(sourceDir)) {
      throw new Error('Arquivos processados não encontrados.');
    }

    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.on('error', (err) => {
      throw err;
    });

    archive.pipe(res);
    archive.directory(sourceDir, false);
    await archive.finalize();
  }
}

module.exports = new AudioService();