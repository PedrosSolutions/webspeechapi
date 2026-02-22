const STORAGE_KEY = 'chat_messages';
const MAX_INPUT_LENGTH = 2000;
const MAX_TEXTAREA_HEIGHT = 140;

const chatHistory = document.getElementById('chatHistory');
const emptyState  = document.getElementById('emptyState');
const messageInput = document.getElementById('messageInput');
const btnSend  = document.getElementById('btnSend');
const btnMic   = document.getElementById('btnMic');
const btnClear = document.getElementById('btnClear');

// --- Storage ---

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

// --- Rendering ---

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
  bubble.textContent = message.text;

  const time = document.createElement('span');
  time.classList.add('message-time');
  time.textContent = formatTime(message.timestamp);

  wrapper.appendChild(bubble);
  wrapper.appendChild(time);
  return wrapper;
}

function renderAll(messages) {
  // Remove all bubbles (keep emptyState)
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

// --- ID generation ---

function generateMessageId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

// --- Sending ---

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  if (text.length > MAX_INPUT_LENGTH) return;

  const message = {
    id: generateMessageId(),
    text,
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

// --- Auto-resize textarea ---

function autoResize() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px';
}

// --- Event listeners ---

btnSend.addEventListener('click', sendMessage);

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

messageInput.addEventListener('input', autoResize);

btnClear.addEventListener('click', () => {
  if (!confirm('Opravdu smazat celou historii?')) return;
  localStorage.removeItem(STORAGE_KEY);
  renderAll([]);
});

// Mic is not yet connected - disable the button with a tooltip hint
btnMic.disabled = true;
btnMic.setAttribute('title', 'Hlasový vstup bude k dispozici brzy.');

// --- Init ---

renderAll(loadMessages());
messageInput.focus();
