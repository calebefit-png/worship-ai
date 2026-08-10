f/**
 * player-ui.js
 * -----------------------------------------------------------------------
 * Liga o StemPlayer (player.js) e o WaveformRenderer (waveform.js) aos
 * elementos do DOM: upload por arraste ou clique, progresso em tempo real
 * (SSE), histórico de projetos, montagem das linhas de canal a partir dos
 * stems retornados pela API, play/pause global, seek sincronizado,
 * volume/mute/solo por stem (com persistência em localStorage) e waveform
 * em canvas. Inclui atalhos de teclado: Espaço (play/pause), M (mute do
 * canal focado), S (solo do canal focado).
 * -----------------------------------------------------------------------
 */

const API_BASE = 'https://worship-ai-api.onrender.com/api/v1/audio';
const VOLUME_PRESETS_KEY = 'moises_v2_volume_presets';

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  progressPanel: document.getElementById('progress-panel'),
  progressLabel: document.getElementById('progress-label'),
  progressPercent: document.getElementById('progress-percent'),
  progressFill: document.getElementById('progress-fill'),
  historyList: document.getElementById('history-list'),
  refreshHistoryBtn: document.getElementById('refresh-history-btn'),
  form: document.getElementById('track-form'),
  input: document.getElementById('track-id-input'),
  loadBtn: document.getElementById('load-btn'),
  loadStatus: document.getElementById('load-status'),
  playBtn: document.getElementById('play-btn'),
  playIcon: document.getElementById('play-icon'),
  pauseIcon: document.getElementById('pause-icon'),
  timeCurrent: document.getElementById('time-current'),
  timeDuration: document.getElementById('time-duration'),
  seekBar: document.getElementById('seek-bar'),
  seekFill: document.getElementById('seek-fill'),
  seekHandle: document.getElementById('seek-handle'),
  channelList: document.getElementById('channel-list'),
  status: document.getElementById('player-status'),
};

let player = null;
let waveforms = {}; // stem -> WaveformRenderer
let progressSource = null; // EventSource ativo
let focusedStem = null; // stem focado para atalhos M/S

// ---------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------

function formatTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('is-error', isError);
}

function loadVolumePresets() {
  try {
    return JSON.parse(localStorage.getItem(VOLUME_PRESETS_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function saveVolumePreset(trackId, stem, value) {
  const presets = loadVolumePresets();
  if (!presets[trackId]) presets[trackId] = {};
  presets[trackId][stem] = value;
  try {
    localStorage.setItem(VOLUME_PRESETS_KEY, JSON.stringify(presets));
  } catch (e) { /* storage indisponível — ignora silenciosamente */ }
}

function getVolumePreset(trackId, stem) {
  const presets = loadVolumePresets();
  if (presets[trackId] && typeof presets[trackId][stem] === 'number') {
    return presets[trackId][stem];
  }
  return 1;
}

// ---------------------------------------------------------------------
// Upload (drag-and-drop + clique)
// ---------------------------------------------------------------------

function setProgress(percent, message, isError = false) {
  els.progressPanel.hidden = false;
  els.progressPercent.textContent = `${Math.round(percent)}%`;
  els.progressLabel.textContent = message;
  els.progressFill.style.width = `${Math.round(percent)}%`;
  els.progressFill.classList.toggle('is-error', isError);
}

function hideProgress() {
  els.progressPanel.hidden = true;
}

function closeProgressStream() {
  if (progressSource) {
    progressSource.close();
    progressSource = null;
  }
}

function watchProgress(trackId) {
  closeProgressStream();
  progressSource = new EventSource(`${API_BASE}/tracks/${trackId}/progress`);

  progressSource.onmessage = (evt) => {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch (e) {
      return;
    }

    setProgress(data.percent || 0, data.message || data.status, data.status === 'FAILED');

    if (data.status === 'COMPLETED') {
      closeProgressStream();
      setTimeout(hideProgress, 1200);
      loadHistory();
      loadTrack(trackId);
    } else if (data.status === 'FAILED') {
      closeProgressStream();
      setStatus(data.message || 'Falha no processamento.', true);
      loadHistory();
    }
  };

  progressSource.onerror = () => {
    closeProgressStream();
  };
}

async function uploadFile(file) {
  if (!file) return;

  const allowedExt = /\.(mp3|wav)$/i;
  if (!allowedExt.test(file.name)) {
    setStatus('Formato inválido. Apenas MP3 e WAV são permitidos.', true);
    return;
  }

  setStatus('');
  setProgress(0, 'Enviando arquivo...');

  const formData = new FormData();
  formData.append('file', file);

  try {
    const xhr = new XMLHttpRequest();
    const uploadPromise = new Promise((resolve, reject) => {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percent = (e.loaded / e.total) * 100;
          setProgress(percent, 'Enviando arquivo...');
        }
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          let msg = `Falha no upload (HTTP ${xhr.status})`;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) { /* ignore */ }
          reject(new Error(msg));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Erro de rede durante o upload.')));
      xhr.open('POST', `${API_BASE}/upload`);
      xhr.send(formData);
    });

    const result = await uploadPromise;
    setProgress(0, 'Na fila de processamento...');
    watchProgress(result.trackId);
    loadHistory();
  } catch (err) {
    setStatus(err.message, true);
    hideProgress();
  }
}

els.dropzone.addEventListener('click', () => els.fileInput.click());

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files[0];
  uploadFile(file);
  els.fileInput.value = '';
});

['dragenter', 'dragover'].forEach((evtName) => {
  els.dropzone.addEventListener(evtName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropzone.classList.add('is-dragover');
  });
});

['dragleave', 'dragend'].forEach((evtName) => {
  els.dropzone.addEventListener(evtName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropzone.classList.remove('is-dragover');
  });
});

els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  els.dropzone.classList.remove('is-dragover');
  const file = e.dataTransfer.files[0];
  uploadFile(file);
});

// ---------------------------------------------------------------------
// Histórico de projetos
// ---------------------------------------------------------------------

function statusLabel(status) {
  const map = {
    PENDING: 'Na fila',
    PROCESSING: 'Processando',
    COMPLETED: 'Concluído',
    FAILED: 'Falhou',
  };
  return map[status] || status;
}

async function loadHistory() {
  try {
    const res = await fetch(`${API_BASE}/tracks`);
    if (!res.ok) return;
    const tracks = await res.json();
    renderHistory(tracks);
  } catch (e) {
    // Histórico é auxiliar — falha silenciosa não deve travar o player.
  }
}

function renderHistory(tracks) {
  els.historyList.innerHTML = '';

  if (!tracks || tracks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Nenhum projeto ainda. Envie um áudio para começar.';
    els.historyList.appendChild(empty);
    return;
  }

  for (const track of tracks) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <span class="history-item-name">${track.original_name || track.id}</span>
      <span class="history-item-badge status-${track.status.toLowerCase()}">${statusLabel(track.status)}</span>
    `;
    item.addEventListener('click', () => {
      if (track.status === 'COMPLETED') {
        loadTrack(track.id);
      } else if (track.status === 'PROCESSING' || track.status === 'PENDING') {
        setProgress(0, 'Acompanhando processamento...');
        watchProgress(track.id);
      } else if (track.status === 'FAILED') {
        setStatus('Processamento desta track falhou anteriormente.', true);
      }
    });
    els.historyList.appendChild(item);
  }
}

els.refreshHistoryBtn.addEventListener('click', loadHistory);

// ---------------------------------------------------------------------
// Player (transporte, canais, waveform)
// ---------------------------------------------------------------------

async function fetchStemList(trackId) {
  const res = await fetch(`${API_BASE}/tracks/${trackId}/stems`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Não foi possível listar os stems (HTTP ${res.status})`);
  if (!json.stems || json.stems.length === 0) throw new Error('Nenhum stem encontrado para esta track.');
  return json.stems.map((s) => s.stem); // ['vocals','drums','bass','other']
}

function buildChannelRows(stemNames, trackId) {
  els.channelList.innerHTML = '';
  waveforms = {};
  focusedStem = null;

  for (const stem of stemNames) {
    const row = document.createElement('div');
    row.className = 'channel';
    row.dataset.stem = stem;
    row.tabIndex = 0;
    row.innerHTML = `
      <div class="channel-name"><span class="dot"></span>${stem}</div>
      <canvas class="channel-waveform" data-stem="${stem}"></canvas>
      <div class="channel-controls">
        <button class="icon-btn mute-btn" title="Mute (M)">M</button>
        <button class="icon-btn solo-btn" title="Solo (S)">S</button>
        <input type="range" class="volume-slider" min="0" max="1" step="0.01" value="1" />
      </div>
    `;
    els.channelList.appendChild(row);

    const canvas = row.querySelector('canvas');
    waveforms[stem] = new WaveformRenderer(canvas);

    row.addEventListener('focusin', () => {
      focusedStem = stem;
      for (const r of els.channelList.children) r.classList.remove('is-focused');
      row.classList.add('is-focused');
    });

    row.querySelector('.mute-btn').addEventListener('click', (e) => {
      const active = player.toggleMute(stem);
      e.currentTarget.classList.toggle('mute-active', active);
    });

    row.querySelector('.solo-btn').addEventListener('click', (e) => {
      const active = player.toggleSolo(stem);
      e.currentTarget.classList.toggle('solo-active', active);
      row.classList.toggle('is-soloed', active);
    });

    const volumeSlider = row.querySelector('.volume-slider');
    const savedVolume = getVolumePreset(trackId, stem);
    volumeSlider.value = savedVolume;

    volumeSlider.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      player.setVolume(stem, value);
      saveVolumePreset(trackId, stem, value);
    });

    // Clique na waveform do stem também faz seek global (sincronizado)
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      player.seek(ratio * player.duration);
    });
  }
}

function applyStoredVolumes(trackId, stemNames) {
  for (const stem of stemNames) {
    const value = getVolumePreset(trackId, stem);
    player.setVolume(stem, value);
  }
}

function updatePlayheads(progressRatio) {
  for (const stem in waveforms) waveforms[stem].draw(progressRatio);
}

function updateTransportUI(currentTime, duration) {
  els.timeCurrent.textContent = formatTime(currentTime);
  els.timeDuration.textContent = formatTime(duration);
  const ratio = duration > 0 ? currentTime / duration : 0;
  els.seekFill.style.width = `${ratio * 100}%`;
  els.seekHandle.style.left = `${ratio * 100}%`;
  updatePlayheads(ratio);
}

function setPlayingIcon(isPlaying) {
  els.playIcon.style.display = isPlaying ? 'none' : 'block';
  els.pauseIcon.style.display = isPlaying ? 'block' : 'none';
}

async function loadTrack(trackId) {
  setStatus('');
  els.loadBtn.disabled = true;
  els.playBtn.disabled = true;
  els.loadStatus.textContent = 'Buscando stems…';
  closeProgressStream();

  try {
    if (player) {
      player.destroy();
      player = null;
    }

    const stemNames = await fetchStemList(trackId);
    buildChannelRows(stemNames, trackId);

    player = new StemPlayer(trackId, stemNames, API_BASE);
    player.onLoadProgress((loaded, total) => {
      els.loadStatus.textContent = `Carregando áudio: ${loaded}/${total} stems`;
    });
    player.onTimeUpdate(updateTransportUI);
    player.onEnded(() => setPlayingIcon(false));

    await player.load();
    applyStoredVolumes(trackId, stemNames);

    // Desenha as waveforms assim que os buffers estão prontos
    for (const stem of stemNames) {
      waveforms[stem].setAudioBuffer(player.buffers[stem]);
    }

    els.loadStatus.textContent = `${stemNames.length} stems carregados — ${formatTime(player.duration)}`;
    els.timeDuration.textContent = formatTime(player.duration);
    els.playBtn.disabled = false;
    setPlayingIcon(false);
    hideProgress();
  } catch (err) {
    setStatus(err.message, true);
    els.loadStatus.textContent = '';
  } finally {
    els.loadBtn.disabled = false;
  }
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const trackId = els.input.value.trim();
  if (!trackId) return;
  loadTrack(trackId);
});

els.playBtn.addEventListener('click', async () => {
  if (!player) return;
  if (player.playing) {
    player.pause();
    setPlayingIcon(false);
  } else {
    await player.play();
    setPlayingIcon(true);
  }
});

els.seekBar.addEventListener('click', (e) => {
  if (!player) return;
  const rect = els.seekBar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  player.seek(ratio * player.duration);
});

// ---------------------------------------------------------------------
// Atalhos de teclado: Espaço (play/pause), M (mute), S (solo)
// Ignorados quando o foco está em um campo de texto, para não interferir
// na digitação do trackId.
// ---------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (!player) return;

  if (e.code === 'Space') {
    e.preventDefault();
    els.playBtn.click();
    return;
  }

  if (!focusedStem) return;

  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    const row = els.channelList.querySelector(`[data-stem="${focusedStem}"]`);
    if (row) row.querySelector('.mute-btn').click();
  }

  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    const row = els.channelList.querySelector(`[data-stem="${focusedStem}"]`);
    if (row) row.querySelector('.solo-btn').click();
  }
});

// ---------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------

loadHistory();
