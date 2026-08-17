/**
 * Separação real de 4 stems com Open-Unmix UMX-L em ONNX.
 *
 * O HT-Demucs de saída única excede 512 MiB durante a inferência no Render
 * gratuito. Esta implementação usa quatro modelos Open-Unmix especialistas
 * (vocals, drums, bass e other), cada um carregado e liberado isoladamente.
 * A inferência é realizada em blocos de 100 frames de espectrograma e a
 * reconstrução usa STFT/ISTFT em streaming, para manter o uso de memória
 * estável abaixo do limite do serviço.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const { fork } = require('child_process');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const FFT = require('fft.js');
const logger = require('../middleware/logger');

const MODEL_DIR = process.env.MODEL_DIR || path.resolve(__dirname, '..', '..', 'models');
const MODEL_REPOSITORY = process.env.OPEN_UNMIX_MODEL_REPOSITORY || 'https://huggingface.co/nsosu/demucs-onnx/resolve/main';
const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
const MODEL_MIN_BYTES = Number(process.env.OPEN_UNMIX_MODEL_MIN_BYTES || 80_000_000);

const SR = 44100;
const NFFT = 4096;
const HOP = 1024;
const BINS = NFFT / 2 + 1;
const FRAMES_PER_BLOCK = 100;
// A mesma margem usada pela referência Open-Unmix JS antes da STFT.
const PAD = NFFT - HOP;
const fft = new FFT(NFFT);

let modelsReady = null;
let modelsError = null;

function modelPath(stem) {
  return path.join(MODEL_DIR, `umxl_${stem}.onnx`);
}

async function downloadModel(stem) {
  const target = modelPath(stem);
  const temp = `${target}.download`;
  const url = `${MODEL_REPOSITORY}/umxl_${stem}.onnx`;
  logger.info(`Baixando modelo Open-Unmix para ${stem}...`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download do modelo ${stem} falhou (HTTP ${response.status})`);
  }
  await fsp.rm(temp, { force: true });
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp, { flags: 'w' }));
    const stat = await fsp.stat(temp);
    if (stat.size < MODEL_MIN_BYTES) throw new Error(`Modelo ${stem} incompleto (${stat.size} bytes)`);
    await fsp.rename(temp, target);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

async function ensureModel() {
  if (modelsReady) return modelsReady;
  if (modelsError) throw modelsError;
  modelsReady = (async () => {
    await fsp.mkdir(MODEL_DIR, { recursive: true });
    for (const stem of STEM_NAMES) {
      const file = modelPath(stem);
      const complete = await fsp.stat(file).then((s) => s.size >= MODEL_MIN_BYTES).catch(() => false);
      if (!complete) {
        await fsp.rm(file, { force: true });
        await downloadModel(stem);
      }
    }
    logger.info('Modelos Open-Unmix de quatro stems disponíveis.');
    return true;
  })().catch((error) => {
    modelsError = error;
    modelsReady = null;
    throw error;
  });
  return modelsReady;
}

function createHannWindow() {
  const result = new Float32Array(NFFT);
  for (let i = 0; i < NFFT; i++) result[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / NFFT));
  return result;
}

const HANN = createHannWindow();

function writeWavStereo(filePath, left, right, sampleRate) {
  const samples = left.length;
  const bytes = 44 + samples * 4;
  const buffer = Buffer.allocUnsafe(bytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(bytes - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 4, 40);
  let cursor = 44;
  for (let i = 0; i < samples; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    buffer.writeInt16LE(Math.round(l * (l < 0 ? 32768 : 32767)), cursor);
    buffer.writeInt16LE(Math.round(r * (r < 0 ? 32768 : 32767)), cursor + 2);
    cursor += 4;
  }
  fs.writeFileSync(filePath, buffer);
}

function makeBlockInput(signal, blockStartFrame) {
  const values = new Float32Array(2 * BINS * FRAMES_PER_BLOCK);
  const frame = new Float32Array(NFFT);
  const spectrum = fft.createComplexArray();
  for (let frameIndex = 0; frameIndex < FRAMES_PER_BLOCK; frameIndex++) {
    const sourceStart = (blockStartFrame + frameIndex) * HOP - PAD;
    for (let i = 0; i < NFFT; i++) {
      const sourceIndex = sourceStart + i;
      const sample = sourceIndex >= 0 && sourceIndex < signal.length ? signal[sourceIndex] : 0;
      frame[i] = sample * HANN[i];
    }
    fft.realTransform(spectrum, frame);
    for (let bin = 0; bin < BINS; bin++) {
      const magnitude = Math.hypot(spectrum[2 * bin], spectrum[2 * bin + 1]);
      const base = bin * FRAMES_PER_BLOCK + frameIndex;
      // A entrada normalizada é estéreo; o pré-processamento do serviço a
      // converte para mono antes deste módulo, portanto duplicamos os canais.
      values[base] = magnitude;
      values[BINS * FRAMES_PER_BLOCK + base] = magnitude;
    }
  }
  return values;
}

function addOutputBlock(signal, outputData, blockStartFrame, left, right, weights) {
  const frame = new Float32Array(NFFT);
  const spectrum = fft.createComplexArray();
  const timeDomain = fft.createComplexArray();
  const channelSpan = BINS * FRAMES_PER_BLOCK;
  for (let frameIndex = 0; frameIndex < FRAMES_PER_BLOCK; frameIndex++) {
    const sourceStart = (blockStartFrame + frameIndex) * HOP - PAD;
    for (let channel = 0; channel < 2; channel++) {
      for (let i = 0; i < NFFT; i++) {
        const sourceIndex = sourceStart + i;
        frame[i] = sourceIndex >= 0 && sourceIndex < signal.length ? signal[sourceIndex] * HANN[i] : 0;
      }
      fft.realTransform(spectrum, frame);
      for (let bin = 0; bin < BINS; bin++) {
        const real = spectrum[2 * bin];
        const imaginary = spectrum[2 * bin + 1];
        const inputMagnitude = Math.hypot(real, imaginary);
        const estimate = Math.max(0, outputData[channel * channelSpan + bin * FRAMES_PER_BLOCK + frameIndex]);
        const factor = inputMagnitude > 1e-12 ? estimate / inputMagnitude : 0;
        spectrum[2 * bin] = real * factor;
        spectrum[2 * bin + 1] = imaginary * factor;
      }
      // DC e Nyquist são puramente reais e a API de fft.js exige o espectro
      // completo antes da transformada inversa.
      spectrum[1] = 0;
      spectrum[2 * (NFFT / 2) + 1] = 0;
      fft.completeSpectrum(spectrum);
      fft.inverseTransform(timeDomain, spectrum);
      const destination = channel === 0 ? left : right;
      for (let i = 0; i < NFFT; i++) {
        const destinationIndex = sourceStart + i;
        if (destinationIndex < 0 || destinationIndex >= destination.length) continue;
        const win = HANN[i];
        destination[destinationIndex] += timeDomain[2 * i] * win;
        if (channel === 0) weights[destinationIndex] += win * win;
      }
    }
  }
}

function normalizeAndCrop(left, right, weights, samples) {
  const outLeft = new Float32Array(samples);
  const outRight = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const denominator = weights[i] > 1e-8 ? weights[i] : 1;
    outLeft[i] = left[i] / denominator;
    outRight[i] = right[i] / denominator;
  }
  return [outLeft, outRight];
}

async function separateStem(ort, stem, signal, totalBlocks, progressCb, stemIndex) {
  const session = await ort.InferenceSession.create(modelPath(stem), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'disabled',
    executionMode: 'sequential',
    enableCpuMemArena: false,
    enableMemPattern: false,
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  logger.info(`Sessão Open-Unmix criada para ${stem}.`);
  const outputLength = totalBlocks * FRAMES_PER_BLOCK * HOP + NFFT;
  const left = new Float32Array(outputLength);
  const right = new Float32Array(outputLength);
  const weights = new Float32Array(outputLength);
  try {
    for (let block = 0; block < totalBlocks; block++) {
      const input = makeBlockInput(signal, block * FRAMES_PER_BLOCK);
      const tensor = new ort.Tensor('float32', input, [1, 2, BINS, FRAMES_PER_BLOCK]);
      const output = await session.run({ [session.inputNames[0]]: tensor });
      const outputTensor = output[session.outputNames[0]];
      addOutputBlock(signal, outputTensor.data, block * FRAMES_PER_BLOCK, left, right, weights);
      if (typeof global.gc === 'function') global.gc();
      if (progressCb) progressCb((stemIndex * totalBlocks + block + 1) / (STEM_NAMES.length * totalBlocks));
    }
  } finally {
    await session.release().catch(() => {});
  }
  return normalizeAndCrop(left, right, weights, signal.length);
}

function runStemInChild(job) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, ['--stem-worker'], {
      execArgv: ['--expose-gc'],
      env: { ...process.env, MODEL_DIR },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    let finished = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timeout ao separar o stem ${job.stem}.`));
    }, Number(process.env.STEM_WORKER_TIMEOUT_MS || 180000));

    const finish = (callback) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      callback();
    };

    child.on('message', (message) => {
      if (message.type === 'progress' && job.progressCb) {
        job.progressCb(message.fraction);
      } else if (message.type === 'done') {
        finish(() => resolve());
      } else if (message.type === 'error') {
        finish(() => reject(new Error(message.error)));
      }
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code, signal) => {
      if (!finished && code !== 0) {
        finish(() => reject(new Error(`Worker do stem ${job.stem} terminou com ${signal || `código ${code}`}.`)));
      }
    });

    child.send({
      type: 'start',
      normalizedMonoWav: job.normalizedMonoWav,
      outputPath: job.outputPath,
      stem: job.stem,
    });
  });
}

async function runStemWorker() {
  const message = await new Promise((resolve, reject) => {
    process.once('message', resolve);
    process.once('error', reject);
  });
  if (!message || message.type !== 'start') throw new Error('Mensagem de inicialização do worker inválida.');

  const ort = require('onnxruntime-node');
  const { readWavFloat32 } = await import('./wavReader.mjs');
  const { signal, sampleRate } = await readWavFloat32(message.normalizedMonoWav);
  if (sampleRate !== SR) throw new Error(`Taxa de amostragem inesperada: ${sampleRate}`);
  if (!signal.length) throw new Error('O áudio normalizado não contém amostras.');

  const naturalFrames = Math.max(1, Math.ceil((signal.length + 2 * PAD - NFFT) / HOP) + 1);
  const totalBlocks = Math.ceil(naturalFrames / FRAMES_PER_BLOCK);
  const [left, right] = await separateStem(
    ort,
    message.stem,
    signal,
    totalBlocks,
    (fraction) => {
      if (process.send) process.send({ type: 'progress', fraction: Math.min(1, fraction * STEM_NAMES.length) });
    },
    0,
  );
  writeWavStereo(message.outputPath, left, right, SR);
  if (process.send) process.send({ type: 'done' });
}

async function separateFile(normalizedMonoWav, outDir, progressCb) {
  await ensureModel();
  fs.mkdirSync(outDir, { recursive: true });
  for (let index = 0; index < STEM_NAMES.length; index++) {
    const stem = STEM_NAMES[index];
    await runStemInChild({
      stem,
      normalizedMonoWav,
      outputPath: path.join(outDir, `${stem}.wav`),
      progressCb: (stemFraction) => {
        if (progressCb) progressCb((index + stemFraction) / STEM_NAMES.length);
      },
    });
    logger.info(`Stem Open-Unmix gravado: ${stem}.wav`);
    if (typeof global.gc === 'function') global.gc();
  }
  return { stems: STEM_NAMES };
}

module.exports = { separateFile, ensureModel };

if (process.argv[2] === '--stem-worker') {
  runStemWorker()
    .then(() => process.exit(0))
    .catch((error) => {
      if (process.send) process.send({ type: 'error', error: error.message });
      process.exit(1);
    });
}
