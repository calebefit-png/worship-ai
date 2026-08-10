/*
 * player-ui.js
 * Versão simplificada para modo demo no Render
 */

const API_BASE = 'https://worship-ai-node.onrender.com/api/v1/audio';

const els = {
  form: document.getElementById('track-form'),
  input: document.getElementById('track-id-input'),
  loadBtn: document.getElementById('load-btn'),
  loadStatus: document.getElementById('load-status'),
  playBtn: document.getElementById('play-btn'),
  channelList: document.getElementById('channel-list'),
  status: document.getElementById('player-status')
};

let audioElements = [];
let loaded = false;

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('is-error', isError);
}

async function fetchStemList(trackId) {
  const res = await fetch(`${API_BASE}/tracks/${trackId}/stems`);
  const json = await res.json();

  if (!res.ok) {
    throw new Error(json.error || 'Erro ao buscar stems');
  }

  return json.stems;
}

function renderChannels(stems) {
  els.channelList.innerHTML = '';

  for (const stem of stems) {
    const row = document.createElement('div');
    row.className = 'channel';
    row.innerHTML = `
      <div class='channel-name'>${stem.stem}</div>
      <audio controls src='https://worship-ai-node.onrender.com${stem.url}'></audio>
    `;
    els.channelList.appendChild(row);
  }
}

async function loadTrack(trackId) {
  try {
    els.loadBtn.disabled = true;
    els.loadStatus.textContent = 'Carregando stems...';
    setStatus('');

    const stems = await fetchStemList(trackId);

    renderChannels(stems);

    audioElements = Array.from(
      els.channelList.querySelectorAll('audio')
    );

    loaded = true;

    els.playBtn.disabled = false;
    els.loadStatus.textContent = `${stems.length} stems carregados`;
    setStatus('Pronto para tocar');
  } catch (err) {
    loaded = false;
    els.playBtn.disabled = true;
    els.loadStatus.textContent = '';
    setStatus(err.message, true);
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
  if (!loaded) return;

  for (const audio of audioElements) {
    try {
      audio.currentTime = 0;
      await audio.play();
    } catch (e) {
      console.error(e);
    }
  }
});

setStatus('Digite um trackId e clique em Carregar');
