/*
 * player-ui.js
 * -----------------------------------------------------------------------
 * Interface completa do Player Multifaixa (estilo Moises).
 *
 * Fluxo:
 *   1. Upload (dropzone ou input file) → POST /api/v1/audio/upload
 *   2. Progresso em tempo real via SSE → GET /api/v1/audio/tracks/:id/progress
 *   3. Histórico → GET /api/v1/audio/tracks
 *   4. Carregar track → StemPlayer (player.js) com WaveformRenderer (waveform.js)
 *      volume/mute/solo por canal, seek, atalhos de teclado.
 * -----------------------------------------------------------------------
 */

const API_BASE = '/api/v1/audio';
const STEMS = ['vocals', 'drums', 'bass', 'other'];

const els = {
  // Upload
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  // Progresso
  progressPanel: document.getElementById('progress-panel'),
  progressLabel: document.getElementById('progress-label'),
  progressPercent: document.getElementById('progress-percent'),
  progressFill: document.getElementById('progress-fill'),
  // Histórico
  historyList: document.getElementById('history-list'),
  refreshHistoryBtn: document.getElementById('refresh-history-btn'),
  // TrackId manual
  form: document.getElementById('track-form'),
  input: document.getElementById('track-id-input'),
  loadBtn: document.getElementById('load-btn'),
  loadStatus: document.getElementById('load-status'),
  // Transporte
  playBtn: document.getElementById('play-btn'),
  playIcon: document.getElementById('play-icon'),
  pauseIcon: document.getElementById('pause-icon'),
  timeCurrent: document.getElementById('time-current'),
  timeDuration: document.getElementById('time-duration'),
  seekBar: document.getElementById('seek-bar'),
  seekFill: document.getElementById('seek-fill'),
  seekHandle: document.getElementById('seek-handle'),
  // Canais
  channelList: document.getElementById('channel-list'),
  // Status
  status: document.getElementById('player-status'),
};

/* ------------------------------------------------------------------ */
/* Estado                                                               */
/* ------------------------------------------------------------------ */

let player = null;            // StemPlayer da track ativa
let focusedStem = 'vocals';   // canal selecionado para atalhos M/S
let uploading = false;
let processingSse = null;     // EventSource do progresso
let seekDragging = false;

const fmt = (sec) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('is-error', isError);
}

function setUploadBusy(busy, label = 'Enviando...') {
  uploading = busy;
  els.dropzone.style.pointerEvents = busy ? 'none' : 'auto';
  els.loadBtn.disabled = busy;
  els.refreshHistoryBtn.disabled = busy;
  if (!busy) setStatus('');
  else setStatus(label);
}

/* ------------------------------------------------------------------ */
/* Upload + progresso SSE                                               */
/* ------------------------------------------------------------------ */

async function uploadFile(file) {
  if (uploading) return;
  if (!file || !file.size) {
    setStatus('Nenhum arquivo selecionado.', true);
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  try {
    setUploadBusy(true, 'Enviando áudio...');
    els.progressPanel.hidden = false;
    els.progressLabel.textContent = 'Enviando...';
    els.progressPercent.textContent = '0%';
    els.progressFill.style.width = '0%';
    els.progressFill.classList.remove('is-error');

    const res = await fetch(`${API_BASE}/upload`, { method: 'POST', body: formData });
    const json = await res.json();

    if (!res.ok) {
      throw new Error(json.error || `Upload falhou (HTTP ${res.status}).`);
    }

    const trackId = json.trackId || json.id;
    if (!trackId) throw new Error('Resposta do servidor sem trackId.');

    setStatus(`Upload concluído (${fmtBytes(file.size)}). Processando stems...`);
    subscribeProgress(trackId);
    refreshHistory();
  } catch (err) {
    setUploadBusy(false);
    els.progressFill.classList.add('is-error');
    setStatus(`Erro no upload: ${err.message}`, true);
    els.progressLabel.textContent = 'Erro no envio';
    els.progressPercent.textContent = '0%';
  }
}

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Assina o SSE de progresso de uma track. */
function subscribeProgress(trackId) {
  if (processingSse) {
    try { processingSse.close(); } catch (e) { /* noop */ }
  }

  const url = `${API_BASE}/tracks/${encodeURIComponent(trackId)}/progress`;
  processingSse = new EventSource(url);

  processingSse.addEventListener('progress', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      els.progressLabel.textContent = data.message || 'Processando...';
      els.progressPercent.textContent = `${data.percent ?? 0}%`;
      els.progressFill.style.width = `${data.percent ?? 0}%`;
    } catch (e) { /* evento ignorável */ }
  });

  processingSse.addEventListener('status', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      updateHistoryItemStatus(trackId, data);
    } catch (e) { /* noop */ }
  });

  processingSse.addEventListener('completed', () => {
    closeProgressSse();
    setStatus('Processamento concluído.');
    els.progressFill.style.width = '100%';
    els.progressPercent.textContent = '100%';
    els.progressLabel.textContent = 'Concluído';
    refreshHistory();
    // Auto-carrega a track recém-processada
    setTimeout(() => loadTrack(trackId, { autoPlay: false }), 400);
  });

  processingSse.addEventListener('failed', (ev) => {
    closeProgressSse();
    let msg = 'Falha no processamento.';
    try { msg = JSON.parse(ev.data).message || msg; } catch (e) { /* noop */ }
    els.progressFill.classList.add('is-error');
    els.progressLabel.textContent = 'Falha no processamento';
    setStatus(msg, true);
    refreshHistory();
  });

  processingSse.onerror = () => {
    // SSE fecha por timeout do servidor: reconectar enquanto status não é final
    fetch(`${API_BASE}/tracks/${encodeURIComponent(trackId)}`)
      .then((r) => r.json())
      .then((json) => {
        if (json && (json.status === 'COMPLETED' || json.status === 'FAILED')) {
          closeProgressSse();
          if (json.status === 'COMPLETED') {
            els.progressFill.style.width = '100%';
            els.progressPercent.textContent = '100%';
            els.progressLabel.textContent = 'Concluído';
            loadTrack(trackId, { autoPlay: false });
          } else {
            els.progressFill.classList.add('is-error');
            setStatus(json.error_message || 'Falha no processamento.', true);
          }
          refreshHistory();
        }
      })
      .catch(() => { /* retry no próximo heartbeat */ });
  };
}

function closeProgressSse() {
  if (processingSse) {
    try { processingSse.close(); } catch (e) { /* noop */ }
    processingSse = null;
  }
}

/* ------------------------------------------------------------------ */
/* Dropzone                                                             */
/* ------------------------------------------------------------------ */

els.dropzone.addEventListener('click', () => els.fileInput.click());

els.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropzone.classList.add('is-dragover');
});

els.dropzone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('is-dragover');
});

els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('is-dragover');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

els.fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) uploadFile(file);
  els.fileInput.value = '';
});

/* ------------------------------------------------------------------ */
/* Histórico                                                            */
/* ------------------------------------------------------------------ */

async function refreshHistory() {
  try {
    const res = await fetch(`${API_BASE}/tracks`);
    const json = await res.json();
    renderHistory(Array.isArray(json) ? json : json.tracks || []);
  } catch (err) {
    // histórico é secundário: falha silenciosa
    console.error('Falha ao carregar histórico:', err);
  }
}

function renderHistory(tracks) {
  if (!tracks || tracks.length === 0) {
    els.historyList.innerHTML = '<div class="history-empty">Nenhum projeto ainda. Envie um MP3 para começar.</div>';
    return;
  }
  els.historyList.innerHTML = '';
  for (const t of tracks) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.dataset.trackId = t.id;
    item.innerHTML = `
      <span class="history-item-name" title="${(t.name || t.id).replace(/"/g, '&quot;')}">${escapeHtml(t.name || t.id)}</span>
      <span class="history-item-badge status-${(t.status || 'pending').toLowerCase()}">${statusLabel(t.status)}</span>
    `;
    item.addEventListener('click', () => {
      if (t.status === 'COMPLETED') loadTrack(t.id);
      else if (t.status === 'PROCESSING' || t.status === 'PENDING') subscribeProgress(t.id);
      else if (t.status === 'FAILED') setStatus(t.error_message || 'Processamento falhou. Tente enviar novamente.', true);
    });
    els.historyList.appendChild(item);
  }
}

function updateHistoryItemStatus(trackId, data) {
  const item = els.historyList.querySelector(`.history-item[data-track-id="${trackId}"]`);
  if (!item) return;
  const badge = item.querySelector('.history-item-badge');
  badge.className = `history-item-badge status-${(data.status || 'pending').toLowerCase()}`;
  badge.textContent = statusLabel(data.status);
}

function statusLabel(status) {
  switch (status) {
    case 'PENDING': return 'Na fila';
    case 'PROCESSING': return 'Processando';
    case 'COMPLETED': return 'Concluído';
    case 'FAILED': return 'Falhou';
    default: return 'Pendente';
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

els.refreshHistoryBtn.addEventListener('click', refreshHistory);

/* ------------------------------------------------------------------ */
/* Carregar track → StemPlayer                                          */
/* ------------------------------------------------------------------ */

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const trackId = els.input.value.trim();
  if (trackId) loadTrack(trackId);
});

async function loadTrack(trackId, opts = {}) {
  try {
    els.loadBtn.disabled = true;
    els.loadStatus.textContent = 'Carregando stems...';
    setStatus('Baixando stems e decodificando áudio...');

    if (player) {
      try { player.destroy(); } catch (e) { /* noop */ }
      player = null;
    }

    player = new StemPlayer(trackId, STEMS, API_BASE);

    player.onLoadProgress((loaded, total) => {
      els.loadStatus.textContent = `Carregando stems... ${loaded}/${total}`;
    });

    player.onTimeUpdate((current, duration) => {
      els.timeCurrent.textContent = fmt(current);
      els.timeDuration.textContent = fmt(duration);
      if (!seekDragging) {
        const pct = duration > 0 ? (current / duration) * 100 : 0;
        els.seekFill.style.width = `${pct}%`;
        els.seekHandle.style.left = `${pct}%`;
      }
    });

    player.onEnded(() => {
      setPlayState(false);
      setStatus('Reprodução concluída.');
    });

    await player.load();

    setPlayState(false);
    els.playBtn.disabled = false;
    els.loadStatus.textContent = `${STEMS.length} stems carregados (${fmt(player.duration)})`;
    setStatus('Pronto para tocar.');

    renderChannels();
    if (opts.autoPlay) await player.play();
    setFocus(focusedStem);
  } catch (err) {
    setStatus(`Falha ao carregar a track: ${err.message}`, true);
    els.playBtn.disabled = true;
    els.loadStatus.textContent = '';
    console.error(err);
  } finally {
    els.loadBtn.disabled = false;
  }
}

function setPlayState(playing) {
  els.playIcon.style.display = playing ? 'none' : 'block';
  els.pauseIcon.style.display = playing ? 'block' : 'none';
}

els.playBtn.addEventListener('click', async () => {
  if (!player) return;
  try {
    if (player.playing) player.pause();
    else await player.play();
    setPlayState(player.playing);
  } catch (err) {
    setStatus(`Erro na reprodução: ${err.message}`, true);
  }
});

/* ------------------------------------------------------------------ */
/* Canais (volume / mute / solo / waveform)                             */
/* ------------------------------------------------------------------ */

function renderChannels() {
  els.channelList.innerHTML = '';

  for (const stem of STEMS) {
    const row = document.createElement('div');
    row.className = 'channel';
    row.dataset.stem = stem;

    const nameEl = document.createElement('div');
    nameEl.className = 'channel-name';
    nameEl.innerHTML = `<span class="dot"></span>${stem}`;
    nameEl.addEventListener('click', () => setFocus(stem));

    const canvas = document.createElement('canvas');
    canvas.className = 'channel-waveform';
    canvas.dataset.stem = stem;
    canvas.addEventListener('click', (e) => {
      if (!player || !player.duration) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      player.seek(ratio * player.duration);
    });

    const controls = document.createElement('div');
    controls.className = 'channel-controls';

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'icon-btn mute-btn';
    muteBtn.dataset.stem = stem;
    muteBtn.textContent = 'M';
    muteBtn.title = 'Mute';
    muteBtn.addEventListener('click', () => {
      const muted = player.toggleMute(stem);
      muteBtn.classList.toggle('mute-active', muted);
      volumeSlider.value = muted ? 0 : player.userVolume[stem];
    });

    const soloBtn = document.createElement('button');
    soloBtn.type = 'button';
    soloBtn.className = 'icon-btn solo-btn';
    soloBtn.dataset.stem = stem;
    soloBtn.textContent = 'S';
    soloBtn.title = 'Solo';
    soloBtn.addEventListener('click', () => {
      const soloed = player.toggleSolo(stem);
      soloBtn.classList.toggle('solo-active', soloed);
      row.classList.toggle('is-soloed', soloed);
    });

    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.className = 'volume-slider';
    volumeSlider.min = 0;
    volumeSlider.max = 1;
    volumeSlider.step = 0.01;
    volumeSlider.value = 1;
    volumeSlider.addEventListener('input', () => {
      player.setVolume(stem, parseFloat(volumeSlider.value));
      if (player.muted[stem]) {
        player.muted[stem] = false;
        muteBtn.classList.remove('mute-active');
      }
    });

    controls.appendChild(muteBtn);
    controls.appendChild(soloBtn);
    controls.appendChild(volumeSlider);

    row.appendChild(nameEl);
    row.appendChild(canvas);
    row.appendChild(controls);

    els.channelList.appendChild(row);

    // Waveform do stem
    const buf = player.buffers[stem];
    const renderer = new WaveformRenderer(canvas);
    if (buf) renderer.setAudioBuffer(buf);
    canvas._wf = renderer;
  }
}

/** Atualiza as waveforms com o playhead (chamado durante o playback). */
function drawPlayhead() {
  if (!player || !player.duration) return;
  const progress = player.duration > 0 ? player.getCurrentTime() / player.duration : 0;
  els.channelList.querySelectorAll('canvas.channel-waveform').forEach((c) => {
    if (c._wf && c._wf.peaks) c._wf.draw(progress);
  });
}

// Atualiza o playhead a ~15fps durante o playback
setInterval(() => {
  if (player && player.playing) drawPlayhead();
}, 66);

function setFocus(stem) {
  focusedStem = stem;
  els.channelList.querySelectorAll('.channel').forEach((row) => {
    row.classList.toggle('is-focused', row.dataset.stem === stem);
  });
}

/* ------------------------------------------------------------------ */
/* Seek global (barra de transporte)                                    */
/* ------------------------------------------------------------------ */

function seekFromEvent(e) {
  if (!player || !player.duration) return;
  const rect = els.seekBar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  player.seek(ratio * player.duration);
  els.seekFill.style.width = `${ratio * 100}%`;
  els.seekHandle.style.left = `${ratio * 100}%`;
}

els.seekBar.addEventListener('mousedown', (e) => {
  seekDragging = true;
  seekFromEvent(e);
});
document.addEventListener('mousemove', (e) => {
  if (seekDragging) seekFromEvent(e);
});
document.addEventListener('mouseup', () => {
  if (seekDragging) {
    seekDragging = false;
    if (player && player.playing) drawPlayhead();
  }
});
// Toque (mobile)
els.seekBar.addEventListener('touchstart', (e) => {
  seekDragging = true;
  seekFromEvent(e.touches[0]);
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (seekDragging && e.touches[0]) seekFromEvent(e.touches[0]);
}, { passive: true });
document.addEventListener('touchend', () => {
  seekDragging = false;
  if (player && player.playing) drawPlayhead();
});

/* ------------------------------------------------------------------ */
/* Atalhos de teclado                                                   */
/* ------------------------------------------------------------------ */

document.addEventListener('keydown', async (e) => {
  if (!player) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (player.playing) player.pause();
    else await player.play();
    setPlayState(player.playing);
  } else if (e.key.toLowerCase() === 'm') {
    const muted = player.toggleMute(focusedStem);
    const btn = els.channelList.querySelector(`.mute-btn[data-stem="${focusedStem}"]`);
    if (btn) btn.classList.toggle('mute-active', muted);
  } else if (e.key.toLowerCase() === 's') {
    const soloed = player.toggleSolo(focusedStem);
    const btn = els.channelList.querySelector(`.solo-btn[data-stem="${focusedStem}"]`);
    const row = els.channelList.querySelector(`.channel[data-stem="${focusedStem}"]`);
    if (btn) btn.classList.toggle('solo-active', soloed);
    if (row) row.classList.toggle('is-soloed', soloed);
  }
});

/* ------------------------------------------------------------------ */
/* Inicialização                                                        */
/* ------------------------------------------------------------------ */

refreshHistory();
setStatus('Arraste um MP3/WAV para separar os stems ou car uma track existente.');
