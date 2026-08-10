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
   *
   * IMPORTANTE: este método NUNCA rejeita a Promise. Se o Demucs não estiver
   * instalado (ex.: Render free tier) ou falhar por qualquer motivo (ENOENT,
   * command not found, spawn error, código de saída != 0, stem faltando),
   * ele cai automaticamente em modo demo: copia o áudio original para os
   * 4 arquivos de stem, permitindo que o fluxo da fila sempre complete.
   */
  async processDemucs(trackId, inputPath, onProgress) {
    const outDir = path.join(process.env.PROCESSED_DIR, trackId);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    try {
      const result = await this._runDemucsProcess(trackId, inputPath, outDir, onProgress);
      return result;
    } catch (err) {
      logger.error(`Demucs indisponível/falhou para ${trackId}, entrando em modo demo: ${err.message}`);
      return this._runDemoFallback(trackId, inputPath, outDir, onProgress);
    }
  }

  /**
   * Tentativa real de execução do Demucs. Rejeita em qualquer erro —
   * quem chama (processDemucs) captura e cai no fallback de modo demo.
   */
  _runDemucsProcess(trackId, inputPath, outDir, onProgress) {
    return new Promise((resolve, reject) => {
      const args = ['-o', outDir, inputPath];
      logger.info(`Iniciando Demucs (4 stems) para ${trackId}: demucs ${args.join(' ')}`);

      let proc;
      try {
        proc = spawn('demucs', args);
      } catch (err) {
        return reject(err);
      }

      let stderrBuffer = '';
      let settled = false;

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });

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
        try {
          for (const name of stemNames) {
            fs.renameSync(path.join(demucsDir, name), path.join(outDir, name));
          }
        } catch (err) {
          return reject(err);
        }

        // Limpa a subpasta vazia do Demucs
        try {
          fs.rmSync(path.join(outDir, 'htdemucs'), { recursive: true, force: true });
        } catch (e) { /* não crítico */ }

        logger.info(`Demucs concluído para ${trackId} (4 stems)`);

        const stems = stemNames.reduce((acc, name) => {
          acc[path.parse(name).name] = path.join(outDir, name);
          return acc;
        }, {});

        resolve({ success: true, demoMode: false, outDir, stems });
      });
    });
  }

  /**
   * Fallback usado quando o Demucs não está disponível/falha. Copia o áudio
   * original enviado para os 4 arquivos de stem esperados, garantindo que
   * o restante do sistema (createZip, listStems, download) continue
   * funcionando normalmente, só que sem separação real.
   */
  async _runDemoFallback(trackId, inputPath, outDir, onProgress) {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const stemNames = ['vocals.wav', 'drums.wav', 'bass.wav', 'other.wav'];
    const stems = {};

    if (onProgress) onProgress(50, 'Demucs indisponível, gerando prévia em modo demo...');

    for (const name of stemNames) {
      const destPath = path.join(outDir, name);
      fs.copyFileSync(inputPath, destPath);
      stems[path.parse(name).name] = destPath;
    }

    if (onProgress) onProgress(99, 'Modo demo concluído.');

    logger.info(`Modo demo concluído para ${trackId} (arquivo original copiado para os 4 stems)`);

    return { success: true, demoMode: true, outDir, stems };
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
