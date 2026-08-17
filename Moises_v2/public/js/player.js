/**
 * player.js
 * -----------------------------------------------------------------------
 * Player multifaixa profissional (estilo Moises) usando Web Audio API pura.
 *
 * Estratégia de sincronização:
 *   - Um único AudioContext controla o "relógio mestre" (ctx.currentTime).
 *   - Cada stem tem seu próprio AudioBufferSourceNode + GainNode.
 *   - AudioBufferSourceNode não pode ser pausado/retomado — por isso,
 *     a cada play() criamos nós novos para todos os stems e os
 *     agendamos para o MESMO instante (when = ctx.currentTime + pequeno
 *     lookahead), todos com o mesmo offset. Isso garante sincronismo
 *     sample-accurate entre stems, mesmo em seek.
 *   - Posição atual = ctx.currentTime - startedAtContextTime + startOffset.
 * -----------------------------------------------------------------------
 */

class StemPlayer {
  /**
   * @param {string} trackId
   * @param {string[]} stemNames - ex: ['vocals','drums','bass','other']
   * @param {string} apiBase - ex: '/api/v1/audio'
   */
  constructor(trackId, stemNames, apiBase = '/api/v1/audio') {
    this.trackId = trackId;
    this.stemNames = stemNames;
    this.apiBase = apiBase;

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);

    this.buffers = {};      // stem -> AudioBuffer
    this.gainNodes = {};    // stem -> GainNode
    this.sources = {};      // stem -> AudioBufferSourceNode (só existe enquanto tocando)
    this.userVolume = {};   // stem -> 0..1
    this.muted = {};        // stem -> bool
    this.soloed = new Set();

    this.duration = 0;
    this.startOffset = 0;         // posição (segundos) de onde o próximo play() deve começar
    this.startedAtContextTime = 0; // ctx.currentTime no instante em que o play() atual começou
    this.playing = false;

    this._rafId = null;
    this._onTimeUpdate = null;   // callback(currentTime, duration)
    this._onEnded = null;        // callback()
    this._onLoadProgress = null; // callback(loadedCount, total)
  }

  onTimeUpdate(cb) { this._onTimeUpdate = cb; }
  onEnded(cb) { this._onEnded = cb; }
  onLoadProgress(cb) { this._onLoadProgress = cb; }

  /**
   * Carrega e decodifica os stems em sequência.
   *
   * O Render Free pode demorar vários segundos para entregar cada WAV. Fazer
   * quatro downloads/decodificações de 5–6 MB em paralelo deixa o navegador
   * preso em 1/4 em alguns cold starts. A sequência mantém o pico de memória
   * baixo e o timeout transforma uma falha silenciosa em uma mensagem útil.
   */
  async load() {
    let loaded = 0;
    const total = this.stemNames.length;
    const timeoutMs = 45000;

    for (const stem of this.stemNames) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let encoded = null;

      try {
        const url = `${this.apiBase}/tracks/${encodeURIComponent(this.trackId)}/stems/${encodeURIComponent(stem)}`;
        const res = await fetch(url, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        encoded = await res.arrayBuffer();
        if (encoded.byteLength < 44) throw new Error('WAV vazio ou inválido');
        const audioBuffer = await this.ctx.decodeAudioData(encoded);

        this.buffers[stem] = audioBuffer;
        this.duration = Math.max(this.duration, audioBuffer.duration);

        const gainNode = this.ctx.createGain();
        gainNode.connect(this.masterGain);
        this.gainNodes[stem] = gainNode;
        this.userVolume[stem] = 1;
        this.muted[stem] = false;

        loaded++;
        if (this._onLoadProgress) this._onLoadProgress(loaded, total);
      } catch (err) {
        const detail = err && err.name === 'AbortError'
          ? `tempo limite de ${Math.round(timeoutMs / 1000)}s`
          : (err && err.message ? err.message : String(err));
        throw new Error(`Falha ao carregar stem '${stem}': ${detail}`);
      } finally {
        clearTimeout(timeout);
        encoded = null;
      }
    }

    this._applyGains();
  }

  /** Recalcula o gain efetivo de cada stem considerando volume/mute/solo. */
  _applyGains() {
    const hasSolo = this.soloed.size > 0;
    for (const stem of this.stemNames) {
      const node = this.gainNodes[stem];
      if (!node) continue;
      const audible = hasSolo ? this.soloed.has(stem) : !this.muted[stem];
      const target = audible ? this.userVolume[stem] : 0;
      node.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01);
    }
  }

  setVolume(stem, value) {
    this.userVolume[stem] = Math.max(0, Math.min(1, value));
    this._applyGains();
  }

  toggleMute(stem) {
    this.muted[stem] = !this.muted[stem];
    this._applyGains();
    return this.muted[stem];
  }

  toggleSolo(stem) {
    if (this.soloed.has(stem)) this.soloed.delete(stem);
    else this.soloed.add(stem);
    this._applyGains();
    return this.soloed.has(stem);
  }

  /** Posição atual em segundos, tocando ou pausado. */
  getCurrentTime() {
    if (!this.playing) return this.startOffset;
    return Math.min(this.duration, this.startOffset + (this.ctx.currentTime - this.startedAtContextTime));
  }

  /** Cria e agenda AudioBufferSourceNodes para todos os stems, todos sincronizados. */
  _scheduleSources(offset) {
    const lookahead = 0.08; // pequena folga para o navegador agendar todos os nós no mesmo instante
    const when = this.ctx.currentTime + lookahead;

    for (const stem of this.stemNames) {
      const source = this.ctx.createBufferSource();
      source.buffer = this.buffers[stem];
      source.connect(this.gainNodes[stem]);
      source.start(when, offset);
      this.sources[stem] = source;
    }

    // Detecta fim de reprodução usando o stem mais longo como referência
    const remaining = this.duration - offset;
    this._endTimer = setTimeout(() => {
      if (this.playing) this._handleEnded();
    }, Math.max(0, remaining * 1000) + lookahead * 1000 + 50);

    this.startedAtContextTime = when;
    this.startOffset = offset;
  }

  _stopSources() {
    for (const stem of this.stemNames) {
      const src = this.sources[stem];
      if (src) {
        try { src.stop(); } catch (e) { /* já parado */ }
        src.disconnect();
      }
    }
    this.sources = {};
    if (this._endTimer) clearTimeout(this._endTimer);
  }

  async play() {
    if (this.playing) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this._scheduleSources(this.startOffset);
    this.playing = true;
    this._startTimeUpdateLoop();
  }

  pause() {
    if (!this.playing) return;
    const pos = this.getCurrentTime();
    this._stopSources();
    this.startOffset = pos;
    this.playing = false;
    this._stopTimeUpdateLoop();
    if (this._onTimeUpdate) this._onTimeUpdate(this.startOffset, this.duration);
  }

  /** Seek sincronizado — reagenda todos os stems no novo offset. */
  seek(seconds) {
    const target = Math.max(0, Math.min(this.duration, seconds));
    const wasPlaying = this.playing;
    if (this.playing) this._stopSources();
    this.startOffset = target;
    if (wasPlaying) {
      this._scheduleSources(target);
    } else if (this._onTimeUpdate) {
      this._onTimeUpdate(this.startOffset, this.duration);
    }
  }

  _handleEnded() {
    this._stopSources();
    this.playing = false;
    this.startOffset = this.duration;
    this._stopTimeUpdateLoop();
    if (this._onTimeUpdate) this._onTimeUpdate(this.duration, this.duration);
    if (this._onEnded) this._onEnded();
  }

  _startTimeUpdateLoop() {
    const tick = () => {
      if (!this.playing) return;
      if (this._onTimeUpdate) this._onTimeUpdate(this.getCurrentTime(), this.duration);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopTimeUpdateLoop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  destroy() {
    this._stopSources();
    this._stopTimeUpdateLoop();
    this.ctx.close();
  }
}

window.StemPlayer = StemPlayer;
