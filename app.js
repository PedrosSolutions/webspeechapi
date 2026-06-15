// ─── Config ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'chat_messages';
const MAX_INPUT_LENGTH = 2000;
const MAX_TEXTAREA_HEIGHT = 140;

// Deepgram – vlož svůj API klíč:
const DEEPGRAM_API_KEY = 'fc9cc323c2049afcf2b395ebb244a0cfb2f1c489';

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
