# Voice Streaming (V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zpevnit stávající Deepgram WebSocket streaming hlasový vstup — zachovat živý náhled, ale opravit race conditions a reset stavu přes stejný stavový automat jako V2.

**Architecture:** Stavový automat `idle | starting | recording | stopping | error` zapouzdřený v jednom controller objektu. Klik nastaví stav synchronně. Životní cyklus getUserMedia → WebSocket open → MediaRecorder.start je chráněn proti překrytí sessions přes session token: každá session má unikátní `id`, a callbacky (open/message/close/error) ignorují eventy, jejichž `id` neodpovídá aktuální session. Odeslat/Enter ukončuje session a resetuje stav.

**Tech Stack:** Vanilla JS (ES2020), MediaRecorder API, getUserMedia, WebSocket, Deepgram streaming API.

**Poznámka k testování:** Demo nemá testovací framework a WebSocket/getUserMedia nelze rozumně automatizovat bez headless setupu. Místo unit testů používáme **manuální ověření v prohlížeči** (cílově Chrome/Android) + `node --check` na syntaxi, s častými commity.

**Branch:** Tento plán běží na větvi `voice-streaming` (vytvoří se v Task 1) odvozené z `claude/chat-interface-voice-Y2chT` (NE z voice-record-send — V1 potřebuje původní streaming kód jako základ).

---

### Task 1: Vytvoř větev a konstanty

**Files:**
- Modify: `app.js` (Config sekce + Mic sekce)

- [ ] **Step 1: Vytvoř větev z parentu (NE z voice-record-send)**

```bash
git checkout claude/chat-interface-voice-Y2chT
git checkout -b voice-streaming
git branch --show-current   # → voice-streaming
```

- [ ] **Step 2: Přidej MAX_RECORDING_MS konstantu pod DEEPGRAM_WS_URL**

Najdi konec bloku `DEEPGRAM_WS_URL = ... .toString();` (řádek ~17) a hned pod něj přidej:

```javascript

const MAX_RECORDING_MS = 60000;   // 60s auto-stop pojistka
```

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "V1: branch + MAX_RECORDING_MS constant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Nahraď celou Mic/Deepgram sekci stavovým automatem

**Files:**
- Modify: `app.js:137-257` (celá sekce Mic/Deepgram + click handler)

- [ ] **Step 1: Nahraď CELÝ blok od `// ─── Mic / Deepgram` po click handler**

Vyber v `app.js` celý blok od komentáře `// ─── Mic / Deepgram ───` (řádek ~137)
po konec `btnMic.addEventListener('click', ...)` (řádek ~257) a nahraď tímto:

```javascript
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
```

- [ ] **Step 2: Ověř syntaxi a commit**

```bash
node --check app.js
git add app.js
git commit -m "V1: rewrite streaming with state machine and session guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Odeslat/Enter ukončuje nahrávání

**Files:**
- Modify: `app.js` (sekce Send & clear)

- [ ] **Step 1: Uprav handler Odeslat**

Najdi:

```javascript
btnSend.addEventListener('click', () => sendMessage('text'));
```

Nahraď za:

```javascript
btnSend.addEventListener('click', () => {
  if (stream.state === 'recording' || stream.state === 'starting') {
    stopRecording();   // finální transkript dorazí async, pak uživatel odešle
    return;
  }
  sendMessage('text');
});
```

- [ ] **Step 2: Uprav keydown handler (Enter)**

Najdi:

```javascript
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const wasRecording = isRecording;
    if (wasRecording) stopRecording();
    sendMessage(wasRecording ? 'voice' : 'text');
  }
});
```

Nahraď za:

```javascript
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (stream.state === 'recording' || stream.state === 'starting') {
      stopRecording();   // počkej na finální transkript, pak Enter znovu
      return;
    }
    sendMessage('text');
  }
});
```

- [ ] **Step 3: Ponech `interim` v sendMessage beze změny**

V1 používá `interim` třídu pro živý náhled (na rozdíl od V2). Řádek
`messageInput.classList.remove('interim')` v `sendMessage` proto ZŮSTÁVÁ
beze změny — žádná editace zde není potřeba. Tento krok je jen kontrola,
že jsi ho omylem nesmazal.

- [ ] **Step 4: Ověř a commit**

```bash
node --check app.js
grep -n 'isRecording\|_cleanupRecording' app.js || echo "no dangling refs (good)"
git add app.js
git commit -m "V1: send/Enter stops recording session

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Manuální ověření v prohlížeči

**Files:** žádné (jen ověření)

- [ ] **Step 1: Nasaď na HTTPS dev URL a projdi scénáře**

| Scénář | Expected |
|--------|----------|
| Klik na mic | Tlačítko OKAMŽITĚ zčervená (recording vizuál) |
| Mluvení | Živý náhled (interim text, červený rámeček inputu) |
| Klik stop | Finální text zůstane, rámeček zmizí, tlačítko idle |
| Dvojklik na start | Jen JEDNA session (žádné zdvojené WS) |
| Odeslat během nahrávání | Session se ukončí, finální text dorazí, input se nevyčistí předčasně |
| Po odeslání nové nahrávání | Input PRÁZDNÝ (žádná stará věta) |
| Druhé nahrávání po prvním | Nepřepisuje první větu dokola |
| Odmítnutí mikrofonu | Oranžový error stav + hláška |
| 60s běh | Auto-stop (dočasně sniž MAX_RECORDING_MS pro test) |

- [ ] **Step 2: Ověř na Chrome/Android (cílové prostředí selhání)**

Primárně: okamžitá reakce kliku, žádné zaseknutí na první větě, čistý input po odeslání.

- [ ] **Step 3: Finální commit**

```bash
git commit --allow-empty -m "V1: manual verification passed on Chrome desktop + Android

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
