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

// ─── Mic / Deepgram ───────────────────────────────────────────────────────────
let isRecording   = false;
let dgSocket      = null;   // WebSocket
let mediaRecorder = null;
let micStream     = null;
let confirmedText = '';     // finalized transcript segments

function setMicState(state, title) {
  btnMic.dataset.state = state;  // 'idle' | 'recording' | 'error'
  btnMic.title = title;
}

async function startRecording() {
  // 1) Request microphone
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    setMicState('error', 'Mikrofon nedostupný: ' + err.message);
    return;
  }

  // 2) Open Deepgram WebSocket (auth via subprotocol token)
  dgSocket = new WebSocket(DEEPGRAM_WS_URL, ['token', DEEPGRAM_API_KEY]);
  dgSocket.binaryType = 'arraybuffer';

  dgSocket.addEventListener('open', () => {
    // 3) Start MediaRecorder once WebSocket is open
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    mediaRecorder = new MediaRecorder(micStream, { mimeType });

    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0 && dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(e.data);
      }
    });

    mediaRecorder.start(250);  // chunk každých 250 ms
    isRecording = true;
    setMicState('recording', 'Nahrávám – klikni pro zastavení');
    confirmedText = messageInput.value.trim();  // zachovej existující text
  });

  // 4) Handle transcripts
  dgSocket.addEventListener('message', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    const transcript = data?.channel?.alternatives?.[0]?.transcript ?? '';
    const isFinal    = data?.is_final    ?? false;
    const speechFinal = data?.speech_final ?? false;

    if (!transcript && !isFinal) return;

    if (speechFinal || isFinal) {
      // Finální segment – přidej k potvrzenému textu
      if (transcript) {
        confirmedText = confirmedText
          ? confirmedText + ' ' + transcript
          : transcript;
      }
      messageInput.value = confirmedText;
      messageInput.classList.remove('interim');
    } else {
      // Interim – ukaž živý náhled (potvrzenéText + aktuální interim)
      const preview = confirmedText
        ? confirmedText + (transcript ? ' ' + transcript : '')
        : transcript;
      messageInput.value = preview;
      messageInput.classList.toggle('interim', Boolean(transcript));
    }

    autoResize();
    scrollToBottom();
  });

  dgSocket.addEventListener('close', () => {
    _cleanupRecording();
  });

  dgSocket.addEventListener('error', () => {
    setMicState('error', 'Chyba připojení k Deepgram');
    _cleanupRecording();
  });
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
    // Pošli CloseStream zprávu aby Deepgram odeslal zbývající finální transkript
    dgSocket.send(JSON.stringify({ type: 'CloseStream' }));
    // Socket se zavře sám přes 'close' event → _cleanupRecording()
  } else {
    _cleanupRecording();
  }
}

function _cleanupRecording() {
  isRecording   = false;
  mediaRecorder = null;
  dgSocket      = null;
  micStream     = null;
  confirmedText = '';
  messageInput.classList.remove('interim');
  setMicState('idle', 'Hlasový vstup');
}

btnMic.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
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
