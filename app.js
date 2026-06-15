// ─── Config ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'chat_messages';
const MAX_INPUT_LENGTH = 2000;
const MAX_TEXTAREA_HEIGHT = 140;

// Deepgram – vlož svůj API klíč:
const DEEPGRAM_API_KEY = 'fc9cc323c2049afcf2b395ebb244a0cfb2f1c489';

// Deepgram pre-recorded REST endpoint
const DEEPGRAM_REST_URL =
  'https://api.deepgram.com/v1/listen?' +
  new URLSearchParams({
    model:        'nova-3',
    language:     'cs',
    smart_format: 'true',
  }).toString();

const MAX_RECORDING_MS = 60000;   // 60s auto-stop pojistka

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const chatHistory  = document.getElementById('chatHistory');
const emptyState   = document.getElementById('emptyState');
const messageInput = document.getElementById('messageInput');
const btnSend      = document.getElementById('btnSend');
const btnMic       = document.getElementById('btnMic');
const btnClear     = document.getElementById('btnClear');

// ─── Storage ──────────────────────────────────────────────────────────────────
function loadMessages() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (err) {
    console.error('Failed to load or parse chat messages from localStorage:', err);
    return [];
  }
}

function saveMessages(messages) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch (e) {
    console.error('Failed to save messages to localStorage.', e);
    alert('Nelze uložit zprávy: úložiště prohlížeče je plné nebo nedostupné.');
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
}

function createBubble(message) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('message');
  wrapper.dataset.id = message.id;

  const bubble = document.createElement('div');
  bubble.classList.add('message-bubble');
  if (message.source === 'voice') bubble.classList.add('message-bubble--voice');
  bubble.textContent = message.text;

  const time = document.createElement('span');
  time.classList.add('message-time');
  time.textContent = formatTime(message.timestamp);
  if (message.source === 'voice') {
    time.textContent += '  🎙';
  }

  wrapper.appendChild(bubble);
  wrapper.appendChild(time);
  return wrapper;
}

function renderAll(messages) {
  Array.from(chatHistory.children).forEach(el => {
    if (el !== emptyState) el.remove();
  });
  if (messages.length === 0) {
    emptyState.style.display = '';
    return;
  }
  emptyState.style.display = 'none';
  const fragment = document.createDocumentFragment();
  messages.forEach(msg => fragment.appendChild(createBubble(msg)));
  chatHistory.appendChild(fragment);
  scrollToBottom();
}

function appendBubble(message) {
  emptyState.style.display = 'none';
  chatHistory.appendChild(createBubble(message));
  scrollToBottom();
}

function scrollToBottom() {
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

// ─── ID generation ────────────────────────────────────────────────────────────
function generateMessageId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

// ─── Sending ──────────────────────────────────────────────────────────────────
function sendMessage(source = 'text') {
  const text = messageInput.value.trim();
  if (!text) return;
  if (text.length > MAX_INPUT_LENGTH) return;

  const message = {
    id: generateMessageId(),
    text,
    source,                        // 'text' | 'voice'
    timestamp: new Date().toISOString(),
  };

  const messages = loadMessages();
  messages.push(message);
  saveMessages(messages);
  appendBubble(message);

  messageInput.value = '';
  autoResize();
  messageInput.focus();
}

// ─── Auto-resize textarea ────────────────────────────────────────────────────
function autoResize() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px';
}

// ─── Mic / Recorder (V2: record → send) ─────────────────────────────────────
// Stavový automat: 'idle' | 'starting' | 'recording' | 'processing' | 'error'
const recorder = {
  state: 'idle',
  mediaRecorder: null,
  micStream: null,
  chunks: [],
  autoStopTimer: null,
  mimeType: '',
};

function setMicState(state, title) {
  recorder.state = state;
  // 'starting' sdílí vizuál s 'recording' → uživatel vidí okamžitou odezvu při kliku
  btnMic.dataset.state = (state === 'recording' || state === 'starting') ? 'recording'
                       : state === 'processing' ? 'processing'
                       : state === 'error' ? 'error'
                       : 'idle';
  btnMic.title = title;
}

async function startRecording() {
  // Guard: jen z idle/error lze startovat. Stav nastavíme SYNCHRONNĚ.
  if (recorder.state !== 'idle' && recorder.state !== 'error') return;
  setMicState('starting', 'Spouštím mikrofon…');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    setMicState('error', 'Mikrofon nedostupný: ' + err.message);
    return;
  }

  // Mezi klikem a tímto bodem mohl uživatel stisknout stop → respektuj to.
  if (recorder.state !== 'starting') {
    stream.getTracks().forEach(t => t.stop());
    return;
  }

  recorder.micStream = stream;
  recorder.chunks = [];
  recorder.mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

  try {
    recorder.mediaRecorder = recorder.mimeType
      ? new MediaRecorder(stream, { mimeType: recorder.mimeType })
      : new MediaRecorder(stream);
  } catch (err) {
    stream.getTracks().forEach(t => t.stop());
    setMicState('error', 'Nahrávání nepodporováno: ' + err.message);
    return;
  }

  recorder.mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) recorder.chunks.push(e.data);
  });
  recorder.mediaRecorder.addEventListener('stop', onRecorderStop);

  recorder.mediaRecorder.start();   // bez timeslice – jeden blok na konci
  setMicState('recording', 'Nahrávám – klikni pro zastavení');

  recorder.autoStopTimer = setTimeout(() => {
    if (recorder.state === 'recording') stopRecording();
  }, MAX_RECORDING_MS);
}

function stopRecording() {
  if (recorder.state === 'starting') {
    // Ještě neběží MediaRecorder – jen zruš a ukliď.
    if (recorder.micStream) recorder.micStream.getTracks().forEach(t => t.stop());
    resetRecorder();
    return;
  }
  if (recorder.state !== 'recording') return;
  setMicState('processing', 'Zpracovávám…');
  clearTimeout(recorder.autoStopTimer);
  recorder.autoStopTimer = null;
  // mediaRecorder.stop() spustí 'stop' event → onRecorderStop
  if (recorder.mediaRecorder && recorder.mediaRecorder.state !== 'inactive') {
    recorder.mediaRecorder.stop();
  } else {
    onRecorderStop();
  }
}

async function onRecorderStop() {
  // Uvolni mikrofon hned po zastavení nahrávání
  if (recorder.micStream) {
    recorder.micStream.getTracks().forEach(t => t.stop());
    recorder.micStream = null;
  }

  const chunks = recorder.chunks;
  recorder.chunks = [];

  if (chunks.length === 0) {
    setMicState('error', 'Nic se nenahrálo');
    resetRecorder({ keepErrorState: true });
    return;
  }

  const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });

  try {
    const text = await transcribeBlob(blob);
    if (text) {
      const base = messageInput.value.trim();
      messageInput.value = base ? base + ' ' + text : text;
      autoResize();
    }
    resetRecorder();
    messageInput.focus();
  } catch (err) {
    setMicState('error', 'Přepis selhal: ' + err.message);
    resetRecorder({ keepErrorState: true });
  }
}

async function transcribeBlob(blob) {
  const res = await fetch(DEEPGRAM_REST_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Token ' + DEEPGRAM_API_KEY,
      'Content-Type': blob.type || 'audio/webm',
    },
    body: blob,
  });
  if (!res.ok) {
    throw new Error('HTTP ' + res.status);
  }
  const data = await res.json();
  return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
}

function resetRecorder({ keepErrorState = false } = {}) {
  clearTimeout(recorder.autoStopTimer);
  recorder.autoStopTimer = null;
  recorder.mediaRecorder = null;
  recorder.chunks = [];
  if (recorder.micStream) {
    recorder.micStream.getTracks().forEach(t => t.stop());
    recorder.micStream = null;
  }
  if (!keepErrorState) {
    setMicState('idle', 'Hlasový vstup');
  }
}

btnMic.addEventListener('click', () => {
  if (recorder.state === 'recording' || recorder.state === 'starting') {
    stopRecording();
  } else if (recorder.state === 'idle' || recorder.state === 'error') {
    startRecording();
  }
  // 'processing' → klik ignorován (probíhá přepis)
});

// ─── Send & clear ─────────────────────────────────────────────────────────────
btnSend.addEventListener('click', () => {
  if (recorder.state === 'recording' || recorder.state === 'starting') {
    stopRecording();   // přepis dorazí async, uživatel pak odešle znovu
    return;
  }
  sendMessage('text');
});

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (recorder.state === 'recording' || recorder.state === 'starting') {
      stopRecording();   // počkej na přepis, pak Enter znovu
      return;
    }
    sendMessage('text');
  }
});

messageInput.addEventListener('input', autoResize);

btnClear.addEventListener('click', () => {
  if (!confirm('Opravdu smazat celou historii?')) return;
  localStorage.removeItem(STORAGE_KEY);
  renderAll([]);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
setMicState('idle', 'Hlasový vstup');
renderAll(loadMessages());
messageInput.focus();
