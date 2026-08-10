const fs = require('fs');
const path = require('path');

async function processDemucs(inputPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const stems = ['vocals', 'drums', 'bass', 'other'];
  const result = [];

  for (const stem of stems) {
    const filename = `${stem}.wav`;
    const dest = path.join(outDir, filename);

    // Copia o arquivo original para cada stem demo
    fs.copyFileSync(inputPath, dest);

    result.push({
      name: stem,
      filename,
      path: dest,
      url: `/processed/${path.basename(outDir)}/${filename}`
    });
  }

  return {
    success: true,
    demoMode: true,
    stems: result
  };
}

module.exports = {
  processDemucs
};
