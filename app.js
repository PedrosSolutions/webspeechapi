// ─── Config ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'chat_messages';
const MAX_INPUT_LENGTH = 2000;
const MAX_TEXTAREA_HEIGHT = 140;

// Deepgram – vlož svůj API klíč:
const DEEPGRAM_API_KEY = 'fc9cc323c2049afcf2b395ebb244a0cfb2f1c489';

const DEEPGRAM_WS_URL =
  'wss://api.deepgram.com/v1/listen?' +
  new URLSearchParams({
    model:            'nova-3',
    language:         'cs',
    interim_results:  'true',
    smart_format:     'true',
    endpointing:      '300',   // 300 ms ticha → speech_final
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
  messageInput.classList.remove('interim');
  autoResize();
  messageInput.focus();
}

// ─── Auto-resize textarea ────────────────────────────────────────────────────
function autoResize() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px';
}

// ─── Mic / Deepgram (V1: streaming) ─────────────────────────────────────────
// Stavový automat: 'idle' | 'starting' | 'recording' | 'stopping' | 'error'
// Ochrana proti překrytí sessions: každá session má unikátní id; callbacky
// ignorují eventy z neaktuální session.
const stream = {
  state: 'idle',
  id: 0,            // id aktuální session
  dgSocket: null,
  mediaRecorder: null,
  micStream: null,
  confirmedText: '',
  autoStopTimer: null,
};

function setMicState(state, title) {
  stream.state = state;
  // 'starting'/'stopping' sdílí vizuál s 'recording' → okamžitá odezva při kliku
  btnMic.dataset.state =
    (state === 'recording' || state === 'starting' || state === 'stopping') ? 'recording'
    : state === 'error' ? 'error'
    : 'idle';
  btnMic.title = title;
}

async function startRecording() {
  if (stream.state !== 'idle' && stream.state !== 'error') return;
  const sessionId = ++stream.id;          // nová session
  setMicState('starting', 'Spouštím mikrofon…');
  stream.confirmedText = messageInput.value.trim();

  let micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    if (sessionId !== stream.id) return;  // mezitím nová/zrušená session
    setMicState('error', 'Mikrofon nedostupný: ' + err.message);
    return;
  }

  if (sessionId !== stream.id || stream.state !== 'starting') {
    micStream.getTracks().forEach(t => t.stop());  // uživatel mezitím stopnul
    return;
  }
  stream.micStream = micStream;

  const dgSocket = new WebSocket(DEEPGRAM_WS_URL, ['token', DEEPGRAM_API_KEY]);
  dgSocket.binaryType = 'arraybuffer';
  stream.dgSocket = dgSocket;

  dgSocket.addEventListener('open', () => {
    if (sessionId !== stream.id) { dgSocket.close(); return; }
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    const mr = new MediaRecorder(micStream, { mimeType });
    stream.mediaRecorder = mr;
    mr.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0 && dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(e.data);
      }
    });
    mr.start(250);
    setMicState('recording', 'Nahrávám – klikni pro zastavení');
    stream.autoStopTimer = setTimeout(() => {
      if (sessionId === stream.id && stream.state === 'recording') stopRecording();
    }, MAX_RECORDING_MS);
  });

  dgSocket.addEventListener('message', (e) => {
    if (sessionId !== stream.id) return;
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    const transcript  = data?.channel?.alternatives?.[0]?.transcript ?? '';
    const isFinal     = data?.is_final     ?? false;
    const speechFinal = data?.speech_final ?? false;
    if (!transcript && !isFinal) return;

    if (speechFinal || isFinal) {
      if (transcript) {
        stream.confirmedText = stream.confirmedText
          ? stream.confirmedText + ' ' + transcript
          : transcript;
      }
      messageInput.value = stream.confirmedText;
      messageInput.classList.remove('interim');
    } else {
      const preview = stream.confirmedText
        ? stream.confirmedText + (transcript ? ' ' + transcript : '')
        : transcript;
      messageInput.value = preview;
      messageInput.classList.toggle('interim', Boolean(transcript));
    }
    autoResize();
    scrollToBottom();
  });

  dgSocket.addEventListener('close', () => {
    if (sessionId !== stream.id) return;
    resetRecorder();
  });

  dgSocket.addEventListener('error', () => {
    if (sessionId !== stream.id) return;
    setMicState('error', 'Chyba připojení k Deepgram');
    resetRecorder({ keepErrorState: true });
  });
}

function stopRecording() {
  if (stream.state === 'starting') {
    stream.id++;   // invaliduj běžící start
    if (stream.micStream) stream.micStream.getTracks().forEach(t => t.stop());
    resetRecorder();
    return;
  }
  if (stream.state !== 'recording') return;
  setMicState('stopping', 'Dokončuji…');
  clearTimeout(stream.autoStopTimer);
  stream.autoStopTimer = null;

  if (stream.mediaRecorder && stream.mediaRecorder.state !== 'inactive') {
    stream.mediaRecorder.stop();
  }
  if (stream.micStream) {
    stream.micStream.getTracks().forEach(t => t.stop());
    stream.micStream = null;
  }
  if (stream.dgSocket && stream.dgSocket.readyState === WebSocket.OPEN) {
    // CloseStream → Deepgram pošle zbývající finální transkript, pak 'close' → resetRecorder
    stream.dgSocket.send(JSON.stringify({ type: 'CloseStream' }));
  } else {
    resetRecorder();
  }
}

function resetRecorder({ keepErrorState = false } = {}) {
  clearTimeout(stream.autoStopTimer);
  stream.autoStopTimer = null;
  stream.mediaRecorder = null;
  if (stream.micStream) {
    stream.micStream.getTracks().forEach(t => t.stop());
    stream.micStream = null;
  }
  stream.dgSocket = null;
  stream.confirmedText = '';
  messageInput.classList.remove('interim');
  if (!keepErrorState) {
    setMicState('idle', 'Hlasový vstup');
  }
}

btnMic.addEventListener('click', () => {
  if (stream.state === 'recording' || stream.state === 'starting') {
    stopRecording();
  } else if (stream.state === 'idle' || stream.state === 'error') {
    startRecording();
  }
  // 'stopping' → klik ignorován
});

// ─── Send & clear ─────────────────────────────────────────────────────────────
btnSend.addEventListener('click', () => sendMessage('text'));

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const wasRecording = isRecording;
    if (wasRecording) stopRecording();
    sendMessage(wasRecording ? 'voice' : 'text');
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
