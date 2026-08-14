#!/usr/bin/env node
/** Baixa os quatro modelos Open-Unmix usados no runtime, de modo atômico. */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'models');
const stems = ['vocals', 'drums', 'bass', 'other'];
const baseUrl = process.env.OPEN_UNMIX_MODEL_REPOSITORY || 'https://huggingface.co/nsosu/demucs-onnx/resolve/main';
const minimumBytes = 80_000_000;

async function isComplete(file) {
  return fsp.stat(file).then((stat) => stat.size >= minimumBytes).catch(() => false);
}

async function prepare(stem) {
  const target = path.join(directory, `umxl_${stem}.onnx`);
  if (await isComplete(target)) {
    console.log(`Modelo ${stem} já disponível.`);
    return;
  }
  const temporary = `${target}.download`;
  await fsp.rm(target, { force: true });
  await fsp.rm(temporary, { force: true });
  const url = `${baseUrl}/umxl_${stem}.onnx`;
  console.log(`Baixando modelo Open-Unmix de ${stem}...`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Falha ao baixar ${stem}: HTTP ${response.status}`);
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'w' }));
    if (!(await isComplete(temporary))) throw new Error(`Arquivo de ${stem} incompleto.`);
    await fsp.rename(temporary, target);
    console.log(`Modelo ${stem} pronto.`);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

(async () => {
  await fsp.mkdir(directory, { recursive: true });
  for (const stem of stems) await prepare(stem);
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
