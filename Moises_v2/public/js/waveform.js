/**
 * waveform.js
 * -----------------------------------------------------------------------
 * Desenha a forma de onda de um AudioBuffer em um <canvas>, e a posição
 * de playback (playhead) por cima. Não depende do player.js — recebe
 * apenas o buffer decodado e o elemento canvas.
 * -----------------------------------------------------------------------
 */

class WaveformRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [colors] - cores customizáveis (lidas do CSS por padrão)
   */
  constructor(canvas, colors = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.peaks = null; // Float32Array de picos pré-calculados (min/max por coluna)
    this.colors = {
      waveform: colors.waveform || 'rgba(124, 92, 255, 0.55)',
      waveformPlayed: colors.waveformPlayed || 'rgba(78, 168, 255, 0.9)',
      background: colors.background || 'transparent',
      playhead: colors.playhead || '#ffffff',
    };
    this._resizeObserver = new ResizeObserver(() => this._syncCanvasSize());
    this._resizeObserver.observe(canvas);
    this._syncCanvasSize();
  }

  _syncCanvasSize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.peaks) this.draw(this._lastProgress || 0);
  }

  /**
   * Pré-calcula picos (min/max) de um AudioBuffer, uma coluna de pixel
   * por bucket de amostras — evita redesenhar milhões de samples a cada frame.
   */
  setAudioBuffer(audioBuffer, resolution = 800) {
    const raw = audioBuffer.getChannelData(0); // canal 0 é suficiente para visual
    const blockSize = Math.max(1, Math.floor(raw.length / resolution));
    const peaks = new Float32Array(resolution * 2); // [min, max] por coluna

    for (let i = 0; i < resolution; i++) {
      const start = i * blockSize;
      let min = 1.0, max = -1.0;
      for (let j = 0; j < blockSize && start + j < raw.length; j++) {
        const v = raw[start + j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks[i * 2] = min;
      peaks[i * 2 + 1] = max;
    }
    this.peaks = peaks;
    this.draw(0);
  }

  /** @param {number} progress - 0 a 1, posição atual de playback */
  draw(progress = 0) {
    this._lastProgress = progress;
    const { ctx, canvas, peaks, colors } = this;
    if (!peaks) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const mid = height / 2;
    const resolution = peaks.length / 2;
    const colWidth = width / resolution;
    const playedCols = Math.floor(progress * resolution);

    ctx.clearRect(0, 0, width, height);
    if (colors.background !== 'transparent') {
      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);
    }

    for (let i = 0; i < resolution; i++) {
      const min = peaks[i * 2];
      const max = peaks[i * 2 + 1];
      const x = i * colWidth;
      const y1 = mid + min * mid * 0.92;
      const y2 = mid + max * mid * 0.92;

      ctx.fillStyle = i < playedCols ? colors.waveformPlayed : colors.waveform;
      ctx.fillRect(x, y1, Math.max(1, colWidth - 0.5), Math.max(1, y2 - y1));
    }

    // Playhead
    const playheadX = progress * width;
    ctx.strokeStyle = colors.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }

  destroy() {
    this._resizeObserver.disconnect();
  }
}

window.WaveformRenderer = WaveformRenderer;
