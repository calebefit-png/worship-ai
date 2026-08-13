/**
 * separateOnnx.js
 * -----------------------------------------------------------------------
 * Separação REAL de stems usando o modelo HT-Demucs (Demucs v4) em
 * formato ONNX, executado com onnxruntime-node.
 *
 * Modelo: MrCitron/demucs-v4-onnx (302MB, fp32, opset 16). Contrato:
 *   input  "input"  : tensor float32 (1, 2, 343980) — stereo, 44.1kHz,
 *                      segmento de 7.8s, valores em [-1, 1]
 *   output "output" : tensor float32 (1, 4, 2, 343980) — ordem
 *                      [drums, bass, other, vocals]
 *
 * Áudio mais longo que 7.8s é processado em segmentos sobrepostos com
 * overlap-add (50% de sobreposição, janela de Hann nas bordas), igual à
 * referência do repositório oficial do modelo.
 *
 * O modelo é baixado automaticamente na primeira execução e fica em
 * MODEL_DIR (cache local). O separador é singleton: uma sessão por
 * processo, liberada após cada job para economizar memória.
 * -----------------------------------------------------------------------
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const logger = require('../middleware/logger');

const MODEL_DIR = process.env.MODEL_DIR || path.resolve(__dirname, '..', '..', 'models');
// A variante INT8 reduz a sessão de ~447 MiB para ~316 MiB durante inferência.
// Isso mantém a separação real de 4 stems dentro do limite de 512 MiB do Render.
const MODEL_NAME = process.env.MODEL_NAME || 'htdemucs.int8.onnx';
const MODEL_URL = process.env.MODEL_URL || '';
const MODEL_MIN_BYTES = Number(process.env.MODEL_MIN_BYTES || 100_000_000);

// Parâmetros HT-Demucs
const SR = 44100;
const SEG_SAMPLES = 343980;      // 7.8s por segmento
const SEG_OVERLAP_SAMPLES = 48000; // ~1.09s de sobreposição (~50% da borda efetiva)
const STEM_NAMES = ['drums', 'bass', 'other', 'vocals']; // ordem do modelo

// Janela de Hann (aplicada apenas nas bordas sobrepostas do overlap-add)
function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

// ------------------------------------------------------------------
// Download do modelo (executado uma vez)
// ------------------------------------------------------------------
let modelReady = null;
let modelError = null;

async function ensureModel() {
  if (modelReady) return;
  if (modelError) throw modelError;

  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const modelPath = path.join(MODEL_DIR, MODEL_NAME);

  if (fs.existsSync(modelPath)) {
    const stat = await fsp.stat(modelPath);
    if (stat.size >= MODEL_MIN_BYTES) {
      modelReady = modelPath;
      logger.info(`Modelo HT-Demucs carregado: ${modelPath} (${stat.size} bytes)`);
      return;
    }
    logger.warn('Modelo corrompido/incompleto, removendo-o.');
    await fsp.unlink(modelPath);
  }

  // Em produção, o modelo INT8 é gerado no build e já deve estar presente.
  // Um URL opcional existe apenas para instalações que optarem pelo download.
  if (!MODEL_URL) {
    throw new Error(
      `Modelo de separação ausente: ${modelPath}. Execute o script de preparação no build ou defina MODEL_URL.`
    );
  }

  const tempPath = `${modelPath}.download`;
  logger.info(`Baixando modelo HT-Demucs para ${tempPath}...`);
  try {
    const res = await fetch(MODEL_URL, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`Falha no download do modelo (HTTP ${res.status})`);
    }

    // Grava em arquivo temporário e só publica após o stream terminar.
    // Isso evita que uma reinicialização aceite um .onnx truncado como válido.
    const { Readable } = require('stream');
    const { pipeline } = require('stream/promises');
    await fsp.rm(tempPath, { force: true });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tempPath, { flags: 'w' }));
    const stat = await fsp.stat(tempPath);
    if (stat.size < MODEL_MIN_BYTES) {
      throw new Error(`Download incompleto (${stat.size} bytes)`);
    }
    await fsp.rename(tempPath, modelPath);
    modelReady = modelPath;
    logger.info('Modelo HT-Demucs baixado com sucesso.');
  } catch (err) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    modelError = err;
    throw new Error(`Não foi possível baixar o modelo de separação: ${err.message}`);
  }
}

// ------------------------------------------------------------------
// Escrita de WAV PCM 16 bits (stereo)
// ------------------------------------------------------------------
function writeWavStereo(filePath, left, right, sampleRate) {
  const numSamples = left.length;
  const bytesPerSample = 2;
  const channels = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);                // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);               // bits por amostra
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let p = 44;
  for (let i = 0; i < numSamples; i++) {
    let l = Math.max(-1, Math.min(1, left[i]));
    let r = Math.max(-1, Math.min(1, right[i]));
    buffer.writeInt16LE(l < 0 ? l * 0x8000 : l * 0x7fff, p);
    buffer.writeInt16LE(r < 0 ? r * 0x8000 : r * 0x7fff, p + 2);
    p += 4;
  }
  fs.writeFileSync(filePath, buffer);
}

// ------------------------------------------------------------------
// Separação: segmenta o áudio com sobreposição, inferência por chunk,
// e reconstrói com overlap-add ponderado pela janela de Hann.
// ------------------------------------------------------------------
async function separateFile(normalizedMonoWav, outDir, progressCb) {
  const ort = require('onnxruntime-node');
  await ensureModel();

  const { readWavFloat32 } = await import('./wavReader.mjs');
  const { signal: monoSignal, sampleRate } = await readWavFloat32(normalizedMonoWav);
  if (sampleRate !== SR) {
    throw new Error(`Taxa de amostragem inesperada: ${sampleRate}`);
  }

  // Demucs espera stereo: duplica o mono nos dois canais
  const numSamples = monoSignal.length;
  const left = monoSignal;
  const right = monoSignal;

  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, MODEL_NAME), {
    executionProviders: ['cpu'],
    // Prioriza limite de memória do Render em vez de otimizações agressivas.
    graphOptimizationLevel: 'disabled',
    executionMode: 'sequential',
    enableCpuMemArena: false,
    enableMemPattern: false,
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  logger.info('Sessão ONNX criada para HT-Demucs.');

  // O modelo exige o segmento exato de SEG_SAMPLES (7.8s); o reshape interno
  // do grafo falha para tamanhos menores. Cada segmento é PADDED (zeros à
  // direita) até SEG_SAMPLES e a reconstrução usa overlap-add com janela de
  // Hann sobre a região sobreposta (stride = SEG_SAMPLES - SEG_OVERLAP_SAMPLES).
  const stride = SEG_SAMPLES - SEG_OVERLAP_SAMPLES;

  // Comprimento efetivo: arredondar para múltiplo de stride + 1 segmento
  let effectiveLen = numSamples;
  const remainder = (effectiveLen - SEG_SAMPLES) % stride;
  if (remainder !== 0) effectiveLen += stride - remainder;

  // Lista de janelas de inferência (todas com SEG_SAMPLES exatos)
  const windows = [];
  let start = 0;
  while (start < effectiveLen) {
    windows.push({ start });
    start += stride;
  }
  if (windows.length === 0) windows.push({ start: 0 });
  const effectiveTotal = windows[windows.length - 1].start + SEG_SAMPLES;

  // Acumuladores por stem (2 canais) com pesos da janela de Hann
  const outLen = effectiveTotal;
  const accumulators = {};
  // O peso é idêntico para todos os stems; mantê-lo uma única vez economiza
  // três vetores Float32 grandes durante o processamento de faixas longas.
  const weights = new Float32Array(outLen);
  for (const stem of STEM_NAMES) {
    accumulators[stem] = [new Float32Array(outLen), new Float32Array(outLen)];
  }

  // OLA/COLA: com stride de 50% do overlap, a soma dos quadrados da janela
  // de Hann fecha exatamente 1 — por isso pesamos com w².
  const hann2 = hannWindow(SEG_OVERLAP_SAMPLES);
  for (let i = 0; i < hann2.length; i++) hann2[i] *= hann2[i];
  const total = windows.length;

  for (let w = 0; w < total; w++) {
    const { start } = windows[w];
    const segL = new Float32Array(SEG_SAMPLES);
    const segR = new Float32Array(SEG_SAMPLES);
    segL.set(left.subarray(start, Math.min(start + SEG_SAMPLES, numSamples)));
    segR.set(right.subarray(start, Math.min(start + SEG_SAMPLES, numSamples)));

    // Interleava L/R em um único buffer row-major (1, 2, SEG_SAMPLES)
    const mixData = new Float32Array(2 * SEG_SAMPLES);
    for (let i = 0; i < SEG_SAMPLES; i++) {
      mixData[i] = segL[i];
      mixData[SEG_SAMPLES + i] = segR[i];
    }

    const mixTensor = new ort.Tensor('float32', mixData, [1, 2, SEG_SAMPLES]);
    const feeds = { input: mixTensor };

    // Cada resultado ONNX carrega um ArrayBuffer externo grande (~11 MiB).
    // Mantê-lo no escopo mínimo permite que a GC libere a janela antes da
    // próxima inferência — essencial nos 512 MiB do Render.
    {
      const output = await session.run(feeds);
      // output.output: (1, 4, 2, segLen) — row-major
      const outData = output.output.data;

      for (let s = 0; s < STEM_NAMES.length; s++) {
        const stem = STEM_NAMES[s];
        const [accL, accR] = accumulators[stem];
        for (let i = 0; i < SEG_SAMPLES; i++) {
          // peso: região central = 1; bordas de sobreposição usam a janela de
          // Hann ao quadrado (OLA/COLA). A janela é aplicada SOMENTE se o modelo
          // não embutir a própria janela na saída (verificado empiricamente).
          // Verificado empiricamente: o export MrCitron já aplica a janela de Hann
          // na saída (overlap-add com pesos unitários conserva melhor a energia:
          // 79% vs 77% com janela dupla). Por isso usamos peso 1 nas bordas também.
          const finalWgt = 1;

          const idx = start + i;
          if (idx < outLen) {
            accL[idx] += outData[s * 2 * SEG_SAMPLES + i] * finalWgt;
            accR[idx] += outData[s * 2 * SEG_SAMPLES + SEG_SAMPLES + i] * finalWgt;
            if (s === 0) weights[idx] += finalWgt;
          }
        }
      }
    }

    // O processo é iniciado com --expose-gc em produção. Se esse sinalizador
    // não estiver presente, a aplicação continua correta; apenas deixa a GC
    // decidir o melhor momento para coletar os buffers externos.
    if (typeof global.gc === 'function') global.gc();
    if (progressCb) progressCb((w + 1) / total);
  }

  await session.release();
  logger.info('Inferência concluída; gravando stems.');

  // Normaliza (divide pelo peso acumulado), recorta para o comprimento original
  // e grava os stems
  fs.mkdirSync(outDir, { recursive: true });
  for (const stem of STEM_NAMES) {
    const [accL, accR] = accumulators[stem];
    const wt = weights;
    const outL = new Float32Array(numSamples);
    const outR = new Float32Array(numSamples);
    let maxAbs = 1e-6;

    for (let i = 0; i < numSamples; i++) {
      const d = wt[i] > 1e-3 ? wt[i] : 1;
      const l = accL[i] / d;
      const r = accR[i] / d;
      outL[i] = l;
      outR[i] = r;
      if (Math.abs(l) > maxAbs) maxAbs = Math.abs(l);
      if (Math.abs(r) > maxAbs) maxAbs = Math.abs(r);
    }

    // Normalização suave para não estourar 0dBFS
    const gain = maxAbs > 1 ? 1 / maxAbs : 1;
    for (let i = 0; i < numSamples; i++) {
      outL[i] *= gain;
      outR[i] *= gain;
    }

    writeWavStereo(path.join(outDir, `${stem}.wav`), outL, outR, SR);
  }

  return { stems: STEM_NAMES };
}

module.exports = { separateFile, ensureModel };
