const fs = require('fs');
const path = require('path');

const PROCESSED_DIR = path.join(__dirname, '..', 'processed');

async function processDemucs(inputPath, trackId) {
  const outDir = path.join(PROCESSED_DIR, trackId);

  fs.mkdirSync(outDir, { recursive: true });

  const stems = ['vocals', 'drums', 'bass', 'other'];

  for (const stem of stems) {
    const dest = path.join(outDir, `${stem}.wav`);

    // modo demo: copia o áudio original
    fs.copyFileSync(inputPath, dest);
  }

  return {
    success: true,
    demoMode: true
  };
}

function listStems(trackId) {
  const stemsDir = path.join(PROCESSED_DIR, trackId);

  if (!fs.existsSync(stemsDir)) return [];

  return ['vocals', 'drums', 'bass', 'other']
    .map((stem) => {
      const filename = `${stem}.wav`;
      const filePath = path.join(stemsDir, filename);

      if (!fs.existsSync(filePath)) return null;

      return {
        stem,
        name: filename,
        url: `/processed/${trackId}/${filename}`
      };
    })
    .filter(Boolean);
}

module.exports = {
  processDemucs,
  listStems
};
