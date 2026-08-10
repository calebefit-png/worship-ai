const fs = require('fs');
const path = require('path');

async function processDemucs(inputPath, outDir) {
  try {
    // garante a pasta de saída
    fs.mkdirSync(outDir, { recursive: true });

    const stems = ['vocals', 'drums', 'bass', 'other'];
    const result = [];

    for (const stem of stems) {
      const filename = `${stem}.wav`;
      const dest = path.join(outDir, filename);

      // copia o arquivo original para cada stem demo
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
  } catch (err) {
    console.error('ERRO NO MODO DEMO:', err);

    return {
      success: false,
      demoMode: true,
      error: err.message,
      stems: []
    };
  }
}

module.exports = { processDemucs };
