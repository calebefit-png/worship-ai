const fs = require('fs');
const path = require('path');

async function processDemucs(inputPath, outDir) {
  try {
    // Simula processamento real por alguns segundos
    await new Promise(resolve => setTimeout(resolve, 2000));

    fs.mkdirSync(outDir, { recursive: true });

    const stems = ['vocals', 'drums', 'bass', 'other'];
    const result = {};

    for (const stem of stems) {
      const dest = path.join(outDir, `${stem}.wav`);
      fs.copyFileSync(inputPath, dest);
      result[stem] = dest;
    }

    return {
      success: true,
      demoMode: true,
      stems: result
    };
  } catch (err) {
    console.error('Erro no modo demo:', err);

    return {
      success: false,
      demoMode: true,
      error: err.message
    };
  }
}

module.exports = {
  processDemucs
};
