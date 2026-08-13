/**
 * wavReader.mjs
 * -----------------------------------------------------------------------
 * Lê um arquivo WAV arbitrário (qualquer taxa de amostragem, mono ou
 * estéreo, PCM ou compressão ADPCM não suportada) e retorna Float32Array
 * mono com a taxa pedida. Usa decodificação própria para não depender
 * de ffmpeg para leitura.
 * -----------------------------------------------------------------------
 */

import { readFile } from 'node:fs/promises';

function readUInt16LE(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

function readUInt32LE(buf, off) {
  return (
    buf[off] + buf[off + 1] * 256 + buf[off + 2] * 65536 + buf[off + 3] * 16777216
  );
}

function readInt16LE(buf, off) {
  const v = buf[off] | (buf[off + 1] << 8);
  return v & 0x8000 ? v - 0x10000 : v;
}

/**
 * @param {string} filePath
 * @returns {Promise<{signal: Float32Array, sampleRate: number}>}
 */
export async function readWavFloat32(filePath) {
  const buf = Buffer.from(await readFile(filePath));

  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Arquivo WAV inválido');
  }

  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let fmtSize = 0;
  let dataOffset = -1;
  let dataSize = -1;

  let p = 12;
  while (p < buf.length) {
    const tag = buf.toString('ascii', p, p + 4);
    const size = readUInt32LE(buf, p + 4);
    if (tag === 'fmt ') {
      fmtSize = size;
      audioFormat = readUInt16LE(buf, p + 8);
      channels = readUInt16LE(buf, p + 10);
      sampleRate = readUInt32LE(buf, p + 12);
      bitsPerSample = readUInt16LE(buf, p + 22);
    } else if (tag === 'data') {
      dataOffset = p + 8;
      dataSize = size;
    }
    p += 8 + size;
    if (size % 2) p += 1;
  }

  if (dataOffset < 0) throw new Error('WAV sem chunk data');

  // Suporte: PCM (1), float (3), alaw (6), mulaw (7)
  const samples = Math.floor(dataSize / ((bitsPerSample / 8) * channels));

  let monoFloat;
  if (audioFormat === 1 || audioFormat === 3) {
    monoFloat = new Float32Array(samples);
    const bytesPerSample = bitsPerSample / 8;
    let maxAbs = 1e-6;
    for (let i = 0; i < samples; i++) {
      const off = dataOffset + i * bytesPerSample * channels;
      let v = 0;
      if (bitsPerSample === 16) {
        v = readInt16LE(buf, off) / 0x8000;
      } else if (bitsPerSample === 24) {
        const lo = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
        v = (lo & 0x800000 ? lo - 0x1000000 : lo) / 0x800000;
      } else if (bitsPerSample === 32) {
        v = audioFormat === 3 ? buf.readFloatLE(off) : buf.readInt32LE(off) / 0x80000000;
      } else if (bitsPerSample === 8) {
        v = (buf[off] - 128) / 128;
      } else {
        throw new Error(`Bits por amostra não suportado: ${bitsPerSample}`);
      }
      monoFloat[i] = v;
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
  } else if (audioFormat === 6) {
    // a-law
    monoFloat = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      let v = buf[dataOffset + i];
      v = ((v & 0x55) << 1) | ((v & 0xaa) >> 1);
      v ^= 0x55;
      const sign = v & 0x80 ? -1 : 1;
      let mag = v & 0x7f;
      let exp = mag >> 4;
      let mant = mag & 0x0f;
      let val = exp < 1 ? mant << 3 : ((mant | 0x10) << (exp - 1)) << 3;
      monoFloat[i] = (sign * val) / 32768;
    }
  } else if (audioFormat === 7) {
    // mu-law
    monoFloat = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      let v = ~buf[dataOffset + i];
      const sign = v & 0x80 ? -1 : 1;
      const mag = (v & 0x7f) + 33;
      let val = (mag & 0x0f) << ((mag >> 4) + 1);
      val += 8 << ((mag >> 4) + 1);
      monoFloat[i] = (sign * val) / 32768;
    }
  } else {
    throw new Error(`Formato de áudio não suportado: ${audioFormat}`);
  }

  // Downmix estéreo -> mono
  let mono = monoFloat;
  if (channels === 2) {
    const half = samples / 2;
    mono = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      mono[i] = (monoFloat[i * 2] + monoFloat[i * 2 + 1]) / 2;
    }
  } else if (channels > 2) {
    const factor = 1 / channels;
    mono = new Float32Array(samples / channels);
    for (let i = 0; i < mono.length; i++) {
      let acc = 0;
      for (let c = 0; c < channels; c++) acc += monoFloat[i * channels + c];
      mono[i] = acc * factor;
    }
  }

  return { signal: mono, sampleRate };
}
