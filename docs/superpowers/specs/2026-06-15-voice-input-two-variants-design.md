# Hlasový vstup — dvě varianty architektury (design)

Datum: 2026-06-15
Větev výchozí: `claude/chat-interface-voice-Y2chT`

## Kontext a problém

Demo hlasového ovládání chatbota používá Deepgram Nova-3 přes WebSocket streaming
(`app.js`). Klient reportuje nespolehlivé chování nahrávacího tlačítka na PC i mobilu
(primárně Chrome/Android), přestože má mikrofon povolený:

1. **Klik a nic se nestane** — tlačítko nereaguje, žádná chyba (potvrzeno na Chrome/Android;
   na Firefoxu téhož zařízení fungovalo).
2. **Zachytí část, pak utne** — přepis se zasekne uprostřed.
3. **Opakuje starou větu** — při dalším nahrávání se objeví věta z minula a přidává se za ni.
4. **Odeslat neresetuje session** (nově potvrzeno reprodukcí): po odeslání zprávy zůstane
   nahrávání aktivní a `confirmedText` se nevynuluje, takže další diktovaná zpráva začíná
   předchozím textem místo prázdného inputu.

## Root cause

Stav UI je odvozen z asynchronních síťových eventů místo z okamžité uživatelské akce, a celý
životní cyklus stojí na sdílených globálních proměnných (`dgSocket`, `mediaRecorder`,
`micStream`, `confirmedText`) bez ochrany proti překrytí sessions.

Konkrétně:
- `isRecording` se nastaví až v `open` callbacku WebSocketu (`app.js:176`) — mezi klikem
  a startem je proměnlivá síťová prodleva. Click handler (`app.js:251`) rozhoduje podle
  `isRecording`, takže během startu lze spustit druhou session → dvě WS / dva recordery →
  globály se přepíšou, cleanup jedné session vynuluje druhou.
- `confirmedText = messageInput.value.trim()` (`app.js:178`) dědí starý obsah inputu.
- `sendMessage` (`app.js:125`) vymaže input, ale nezastaví session ani nevynuluje
  `confirmedText` → invariant „input == confirmedText" se rozpadne (symptom 4).

Toto je jedna architektonická vada životního cyklu, ne čtyři nezávislé bugy.

## Společný základ (root-cause fix — v OBOU variantách)

1. **Okamžitá odezva tlačítka** — stav `recording` se nastaví synchronně při kliku, ne
   v async callbacku.
2. **Stavový automat** `idle | starting | recording | stopping` — klik ignorován ve stavech
   `starting`/`stopping` (guard proti dvojkliku / překrytí sessions).
3. **Zapouzdřený stav** — jeden recorder controller místo globálních proměnných. Cleanup je
   idempotentní a vázaný na konkrétní session, takže `close`/`error` staré session nevynuluje
   novou.
4. **Odeslat/Enter ukončuje session** — `sendMessage` nejdřív zastaví běžící recorder,
   odešle aktuální text, controller se resetuje do `idle` (vynuluje `confirmedText`, zavře
   socket, uvolní mikrofon, tlačítko → idle). Další mluvení = čistý start.
5. **Viditelné chyby** — každé selhání (`getUserMedia`, WS, nepodporovaný mimetype) →
   chybový stav tlačítka + krátká hláška, žádné tiché spolknutí.
6. **60s auto-stop** — pojistka proti běhu donekonečna a plýtvání kreditem; hodnota jako
   konstanta.

## Varianty

### V1 — `voice-streaming` (zpevněný streaming)
- Zachová Deepgram WebSocket + `interim_results`.
- Živý náhled během mluvení (interim text v inputu, vizuálně odlišený).
- Společný základ řeší dnešní race conditions.
- Výhoda: okamžitá zpětná vazba „vidím, jak se to přepisuje".
- Riziko: víc pohyblivých částí (WS lifecycle), citlivější na síť.

### V2 — `voice-record-send` (record → send)
- Žádný WebSocket. `MediaRecorder` nahraje celý klip do Blobu.
- Během mluvení: pulzující indikátor + timer (žádný živý text).
- Po stopu (ruční / Odeslat / 60s): spinner „přepisuji…", jeden HTTP POST na Deepgram
  pre-recorded API → vrátí celý text → vloží do inputu.
- Výhoda: dramaticky méně stavů = méně failure modes; robustní napříč prohlížeči.
- Riziko: žádný živý náhled, krátká prodleva na konci (čeká na HTTP odpověď).

## Struktura větví

```
claude/chat-interface-voice-Y2chT  (výchozí bod)
├── voice-streaming      (V1)
└── voice-record-send    (V2)
```

Obě větve vyjdou ze stejného bodu → identický základ (chat, localStorage, UI), liší se jen
v sekci Mic v `app.js`. Společný základ je v obou větvích duplikován **záměrně** — větve mají
různou životnost (jedna po rozhodnutí klienta zemře), abstrahovat sdílený modul by byla
předčasná abstrakce. Každá větev je samostatně nasaditelná.

## Jak klient porovná

Každá větev = samostatně funkční demo na své URL. Klient vyzkouší obě na svém Chrome/Androidu
(kde dnes selhává) a řekne, která mu sedí. Vítěznou variantu pak mergneme do hlavní větve.

## Mimo rozsah (YAGNI)

- Backend proxy pro API klíč — rozhodnuto: pro demo klíč zůstává v kódu, po demu rotace.
  (Riziko: klíč je čitelný z DevTools — bereme na vědomí.)
- Reconnection/retry u WebSocketu — při pádu jasná chyba + uživatel klikne znovu.
- Ukládání audia.

## Testování

Manuální ověření na Chrome/Android (cílové prostředí selhání) + desktop Chrome/Firefox:
- klik → okamžitá změna stavu tlačítka,
- dvojklik během startu nespustí druhou session,
- odeslání během nahrávání → čistý reset, další mluvení začíná z prázdna,
- 60s auto-stop,
- chybový stav při odmítnutém mikrofonu / výpadku sítě.
