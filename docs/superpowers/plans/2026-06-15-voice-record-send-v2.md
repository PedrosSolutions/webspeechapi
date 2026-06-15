# Voice Record→Send (V2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nahradit streaming hlasový vstup robustní variantou record→send: nahraj celý klip, po stopu pošli jedním HTTP POST na Deepgram pre-recorded API, vlož celý text do inputu.

**Architecture:** Stavový automat `idle | starting | recording | processing | error` zapouzdřený v jednom controller objektu místo globálních proměnných. Tlačítko reaguje synchronně při kliku. `MediaRecorder` sbírá audio chunky do pole; po stopu se z nich složí Blob a pošle se `fetch` POST na Deepgram. Žádný WebSocket, žádný živý náhled.

**Tech Stack:** Vanilla JS (ES2020), MediaRecorder API, getUserMedia, fetch, Deepgram pre-recorded REST API.

**Poznámka k testování:** Demo nemá testovací framework a Web Audio/getUserMedia nelze rozumně automatizovat bez headless setupu (pro demo overkill). Místo unit testů používáme **manuální ověření v prohlížeči** (cílově Chrome/Android) na konci každé skupiny kroků, s častými commity. Každý ověřovací krok má jasné "Expected".

**Branch:** Tento plán běží na větvi `voice-record-send` (vytvoří se v Task 1) odvozené z `claude/chat-interface-voice-Y2chT`.

---

### Task 1: Vytvoř větev a odstraň streaming kód

**Files:**
- Modify: `app.js:137-257` (celá sekce Mic/Deepgram + click handler)

- [ ] **Step 1: Vytvoř a přepni na větev**

```bash
git checkout claude/chat-interface-voice-Y2chT
git checkout -b voice-record-send
```

- [ ] **Step 2: Smaž starou streaming sekci v app.js**

Smaž v `app.js` celý blok od komentáře `// ─── Mic / Deepgram ───` (řádek ~137)
až po konec `btnMic.addEventListener('click', ...)` (řádek ~257) — tedy:
proměnné `isRecording, dgSocket, mediaRecorder, micStream, confirmedText`,
funkce `setMicState, startRecording, stopRecording, _cleanupRecording`,
a click handler na `btnMic`.

NECHej beze změny: `DEEPGRAM_API_KEY` (řádek 7), ale SMAŽ `DEEPGRAM_WS_URL`
(řádky 9-17) — V2 ho nepoužívá.

Ponech sekce Send & clear i Init beze změny (zatím — handler `Enter` upravíme v Task 5).

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "V2: remove streaming code, prepare for record-send

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Recorder controller — stavový automat a konstanty

**Files:**
- Modify: `app.js` (přidej sekci Mic na místo smazané)

- [ ] **Step 1: Přidej konstanty pod stávající Config (pod řádek `MAX_TEXTAREA_HEIGHT`)**

```javascript
// Deepgram pre-recorded REST endpoint
const DEEPGRAM_REST_URL =
  'https://api.deepgram.com/v1/listen?' +
  new URLSearchParams({
    model:        'nova-3',
    language:     'cs',
    smart_format: 'true',
  }).toString();

const MAX_RECORDING_MS = 60000;   // 60s auto-stop pojistka
```

- [ ] **Step 2: Přidej recorder controller na místo smazané Mic sekce**

```javascript
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
```

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "V2: add recorder controller state and constants

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Start nahrávání (synchronní stav + async getUserMedia)

**Files:**
- Modify: `app.js` (pokračování Mic sekce)

- [ ] **Step 1: Přidej startRecording**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add app.js
git commit -m "V2: implement startRecording with synchronous state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Stop, transkripce přes fetch, a reset

**Files:**
- Modify: `app.js` (pokračování Mic sekce)

- [ ] **Step 1: Přidej stopRecording, onRecorderStop, transcribeBlob, resetRecorder**

```javascript
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
    resetRecorder();
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
```

- [ ] **Step 2: Přidej click handler na btnMic (na konec Mic sekce)**

```javascript
btnMic.addEventListener('click', () => {
  if (recorder.state === 'recording' || recorder.state === 'starting') {
    stopRecording();
  } else if (recorder.state === 'idle' || recorder.state === 'error') {
    startRecording();
  }
  // 'processing' → klik ignorován (probíhá přepis)
});
```

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "V2: implement stop, transcription via fetch, and reset

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Odeslat/Enter ukončuje nahrávání + spinner CSS

**Files:**
- Modify: `app.js` (sekce Send & clear, řádky ~260-269)
- Modify: `style.css` (přidej processing stav)

- [ ] **Step 1: Uprav handler Odeslat tak, aby nejdřív zastavil nahrávání**

Najdi v `app.js`:

```javascript
btnSend.addEventListener('click', () => sendMessage('text'));
```

Nahraď za:

```javascript
btnSend.addEventListener('click', () => {
  if (recorder.state === 'recording' || recorder.state === 'starting') {
    stopRecording();   // přepis dorazí async, uživatel pak odešle znovu
    return;
  }
  sendMessage('text');
});
```

- [ ] **Step 2: Uprav keydown handler (Enter)**

Najdi v `app.js`:

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
    if (recorder.state === 'recording' || recorder.state === 'starting') {
      stopRecording();   // počkej na přepis, pak Enter znovu
      return;
    }
    sendMessage('text');
  }
});
```

- [ ] **Step 3: Přidej processing (spinner) stav do style.css**

Za blok `.btn-mic[data-state="error"]` (řádek ~208) přidej:

```css
/* Processing – přepis probíhá, spinner */
.btn-mic[data-state="processing"] {
  background: var(--bg);
  color: var(--mic);
  border-color: var(--border);
  cursor: progress;
}

.btn-mic[data-state="processing"] svg {
  animation: mic-spin 0.8s linear infinite;
}

@keyframes mic-spin {
  to { transform: rotate(360deg); }
}
```

- [ ] **Step 4: Commit**

```bash
git add app.js style.css
git commit -m "V2: send/Enter stops recording; add processing spinner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Manuální ověření v prohlížeči

**Files:** žádné (jen ověření)

- [ ] **Step 1: Otevři demo v Chrome (desktop) a projdi scénáře**

Otevři `index.html` přes lokální server (ne `file://` — getUserMedia vyžaduje
secure context: `localhost` je OK). Ověř:

| Scénář | Expected |
|--------|----------|
| Klik na mic | Tlačítko OKAMŽITĚ zčervená (recording), bez prodlevy |
| Mluvení + klik stop | Spinner (processing), pak text naskočí do inputu |
| Dvojklik rychle za sebou na start | Spustí se jen JEDNA session (žádné zdvojení) |
| Odeslat během nahrávání | Nahrávání se zastaví, přepis dorazí; input se NEvyčistí dřív |
| Po odeslání zprávy nové nahrávání | Input začíná PRÁZDNÝ (žádná stará věta) |
| Odmítnutí mikrofonu | Oranžový error stav + hláška v title |
| 60s běh | Auto-stop a přepis (lze dočasně snížit MAX_RECORDING_MS pro test) |

- [ ] **Step 2: Ověř na Chrome/Android (cílové prostředí selhání)**

Stejné scénáře jako Step 1, primárně: "klik → okamžitá reakce" a
"po odeslání čistý input". Toto je prostředí, kde dnes klient hlásí selhání.

- [ ] **Step 3: Pokud vše OK, finální commit (značka hotové větve)**

```bash
git commit --allow-empty -m "V2: manual verification passed on Chrome desktop + Android

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
