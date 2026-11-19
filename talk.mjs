// Talk mode (#1105): hold a key (or the 🎙 button), say a command or a message, and Docket does it; replies in the open
// session are read aloud. Speech-to-text runs on this computer (talk-worker.mjs), the commands are matched here
// (talk-grammar.mjs), and the voice is one of this computer's own. Audio never leaves the page; only text you choose to
// send goes to a session, as if typed.
// Only one Docket tab listens and speaks: the one holding the 'docket-talk' lock. Pop-outs never load this file.
// index.html passes in `page`, the few things talk mode does to the page (open a session, send, scroll...), so this
// file has no other reach into it.
import { parse, bestMatch, speakable, primeText, isNoise } from './talk-grammar.mjs';

const keys = () => [['ControlRight', 'Right Ctrl'], ['AltRight', page.talkKey[0] === 'AltRight' ? 'Right Option' : 'Right Alt'], ['ShiftRight', 'Right Shift'], ['F8', 'F8'], ['F9', 'F9']];
// MB downloaded once, from the model files talk-worker.mjs picks (on the processor alone it takes one size down)
const SIZES = { base: { webgpu: 165, wasm: 41 }, small: { webgpu: 410, wasm: 77 } };
const HOLD_MS = 250; // a press on 🎙 longer than this talks; a shorter one turns talk mode on or off

let page, $;
const st = {
  on: false, locked: false, releaseLock: null,
  worker: null, model: null, loadP: null, ready: false, device: '', loadMs: 0, bytes: 0,
  rec: null, pending: null, lastHeard: '', reading: null, seq: 0, wants: new Map(),
  stats: [],
};
const set = (k, v) => page.store.set('talk:' + k, v);
const get = (k, d) => page.store.get('talk:' + k, d);
// The key's default is the page's for this computer (platform part of index.html): Right Ctrl, or Right Option on a Mac.
export const settings = () => ({ key: get('key', page.talkKey[0]), model: get('model', 'base'), device: get('device', 'auto'), read: get('read', true), voice: get('voice', ''), rate: get('rate', 1.1) });
const keyName = () => (keys().find(([k]) => k === settings().key) || [, page.talkKey[1]])[1];

// ---------- the engine: transcribe(audio) → text ----------
// One function, so another engine (the Web Speech API, or #1081's server-side Whisper) can stand in for this one.
function worker() {
  if (st.worker) return st.worker;
  st.worker = new Worker(new URL('./talk-worker.mjs', import.meta.url), { type: 'module' });
  st.worker.onmessage = ({ data }) => {
    if (data.t === 'progress') showLoading(data.loaded, data.total);
    else if (data.t === 'ready') { st.ready = true; st.device = data.device; st.loadMs = data.ms; st.bytes = data.bytes; st.loadDone?.(); showIdle(); }
    else if (data.t === 'text' || data.t === 'error') {
      const w = st.wants.get(data.id);
      if (data.t === 'error' && !w) { st.loadFail?.(new Error(data.error)); return; }
      st.wants.delete(data.id);
      if (data.t === 'text') w?.ok(data); else w?.no(new Error(data.error));
    }
  };
  return st.worker;
}
export function loadModel() {
  const { model, device } = settings();
  if (st.loadP && st.model === model + device) return st.loadP;
  st.model = model + device; st.ready = false;
  st.loadP = new Promise((ok, no) => { st.loadDone = ok; st.loadFail = (e) => { st.loadP = null; no(e); }; });
  st.loadP.catch((e) => strip({ about: `The speech model did not load: ${e.message}`, kind: 'bad' }));
  worker().postMessage({ t: 'load', model, device });
  return st.loadP;
}
export async function transcribe(audio) {
  await loadModel();
  const id = ++st.seq;
  const prompt = primeText(page.desks().map((d) => d.name), page.sessions().map((s) => s.title));
  return new Promise((ok, no) => { st.wants.set(id, { ok, no }); worker().postMessage({ t: 'transcribe', id, audio, prompt }, [audio.buffer]); });
}

// ---------- the microphone: open only while the key or button is held ----------
const WORKLET = `registerProcessor('talk-tap', class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
});`;
async function startRec() {
  if (st.rec) return;
  stopSpeaking(); // the key cuts Docket off
  const rec = st.rec = { chunks: [], at: performance.now(), firstAt: 0, stopped: false, peak: 0 };
  showListening(0);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    rec.stream = stream;
    if (rec.stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
    const ctx = rec.ctx = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
    const src = ctx.createMediaStreamSource(stream), tap = new AudioWorkletNode(ctx, 'talk-tap');
    tap.port.onmessage = ({ data }) => {
      if (rec.stopped) return;
      if (!rec.firstAt) rec.firstAt = performance.now();
      rec.chunks.push(data);
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const level = Math.min(1, Math.sqrt(sum / data.length) * 6); rec.peak = Math.max(rec.peak, level);
      showListening(level);
    };
    src.connect(tap);
  } catch (err) {
    st.rec = null; closeRec(rec);
    strip({ about: err?.name === 'NotAllowedError' ? 'The microphone is blocked for this page. Allow it in the browser (the icon at the left of the address bar), then hold the key again.' : `No microphone: ${err.message}`, kind: 'bad' });
  }
}
function closeRec(rec) {
  rec.stopped = true;
  rec.stream?.getTracks().forEach((t) => t.stop());
  rec.ctx?.close().catch(() => {});
}
async function stopRec(keep = true) {
  const rec = st.rec; if (!rec) return;
  st.rec = null;
  await new Promise((r) => setTimeout(r, 120)); // the last words still in the pipe
  closeRec(rec); showIdle();
  const releasedAt = performance.now() - 120;
  const n = rec.chunks.reduce((a, c) => a + c.length, 0);
  if (!keep || n < 16000 * 0.3 || rec.peak < 0.02) { showIdle(keep && n ? 'Heard nothing. Hold the key while you speak.' : ''); return; }
  const audio = new Float32Array(n); let o = 0; for (const c of rec.chunks) { audio.set(c, o); o += c.length; }
  strip({ heard: '…', about: st.ready ? 'Working out the words…' : 'Getting the speech model ready…' });
  try {
    const r = await transcribe(audio);
    const textAt = performance.now();
    const stat = { device: st.device, seconds: +(n / 16000).toFixed(2), pressToAudio: Math.round((rec.firstAt || releasedAt) - rec.at), releaseToText: Math.round(textAt - releasedAt), transcribe: r.ms, text: r.text };
    await heard(r.text, stat);
    stat.textToAction = Math.round(performance.now() - textAt);
    st.stats.push(stat); if (st.stats.length > 50) st.stats.shift();
  } catch (err) { strip({ about: `Could not work out the words: ${err.message}`, kind: 'bad' }); }
}

// ---------- what was heard, and doing it ----------
export async function heard(text, stat = {}) {
  st.lastHeard = text;
  if (isNoise(text)) { showIdle('Heard nothing. Hold the key while you speak.'); return; }
  const c = parse(text, { pending: !!st.pending });
  stat.kind = c.kind;
  await act(c, text);
}
const titleOf = (s) => s?.title || 'Untitled';
async function act(c, text) {
  const cur = page.current();
  const ask = (about, run, say) => { st.pending = { about, run }; strip({ heard: text, about, confirm: true }); speak([say || about]); };
  switch (c.kind) {
    case 'yes': { const p = st.pending; st.pending = null; if (!p) return; strip({ heard: text, about: `Doing it: ${p.about.replace(/\? Say .*$/, '')}` }); await p.run(); return; }
    case 'cancel': {
      const p = st.pending; st.pending = null;
      if (p?.filled && page.box() === p.filled) page.box('');
      strip({ heard: text, about: p ? 'Cancelled.' : 'Nothing to cancel.' }); speak([p ? 'Cancelled.' : 'Nothing to cancel.']); return;
    }
    case 'stop': stopSpeaking(); strip({ heard: text, about: 'Stopped reading.' }); return;
    case 'desk': {
      const m = bestMatch(c.name, page.desks().map((d) => ({ id: d.id, label: d.name })));
      if (!m) return miss(text, `No desk called "${c.name}".`);
      page.selectDesk(m.id); strip({ heard: text, about: `Went to the ${m.label} desk.` }); return;
    }
    case 'open': {
      const here = page.sessions(), all = page.sessions(true);
      const m = bestMatch(c.name, here.map((s) => ({ id: s.id, label: titleOf(s), desk: s.client })))
        || bestMatch(c.name, all.map((s) => ({ id: s.id, label: titleOf(s), desk: s.client })));
      if (!m) return miss(text, `No session matches "${c.name}".`);
      await page.open(m.id, m.desk);
      strip({ heard: text, about: `Opened ${m.label}.${m.close ? ` (${m.close.label} was close too.)` : ''}` });
      speak([m.label]); return;
    }
    case 'next': {
      const s = page.nextWaiting();
      if (!s) { strip({ heard: text, about: 'Nothing is waiting on you.' }); speak(['Nothing is waiting on you.']); return; }
      await page.open(s.id, s.client); strip({ heard: text, about: `Opened ${titleOf(s)}, waiting on you.` }); speak([`${titleOf(s)}.`]); return;
    }
    case 'scroll': page.scrollPages(c.dir); strip({ heard: text, about: `Scrolled ${c.dir}.` }); return;
    case 'read': return readReply(true);
    case 'more': {
      const rest = st.reading?.rest || [];
      if (!rest.length) { strip({ heard: text, about: 'Nothing more to read.' }); speak(['That is all.']); return; }
      st.reading.rest = []; strip({ heard: text, about: 'Reading the rest.' }); speak(rest); return;
    }
    case 'dictate': case 'answer': {
      if (!cur) return miss(text, 'Open a session first.');
      const msg = c.kind === 'answer' ? `Q${c.n} ${c.text}` : c.text;
      page.box(msg);
      ask(`Send to ${titleOf(cur)}: "${msg}"? Say send or cancel.`, async () => { if (page.box() === msg) page.box(''); await page.send(msg); strip({ about: `Sent to ${titleOf(cur)}.` }); },
        `Send to ${titleOf(cur)}: ${msg}?`);
      st.pending.filled = msg; return;
    }
    case 'send': {
      const box = page.box().trim();
      if (!cur || !box) { strip({ heard: text, about: 'Nothing to send.' }); speak(['Nothing to send.']); return; }
      page.box(''); await page.send(box); strip({ heard: text, about: `Sent to ${titleOf(cur)}.` }); return; // "send" is the yes
    }
    case 'merge': {
      if (!cur || !page.canMerge()) return miss(text, 'No merge is waiting in this session.');
      return ask(`Merge in ${titleOf(cur)}? Say yes or cancel.`, async () => { await page.merge(); strip({ about: 'Sent merge.' }); });
    }
    case 'interrupt': {
      if (!cur || !page.isWorking()) return miss(text, 'This session is not working.');
      return ask(`Stop ${titleOf(cur)}? Say yes or cancel.`, async () => { await page.interrupt(); strip({ about: 'Stopped the session.' }); });
    }
    case 'archive': {
      if (!cur) return miss(text, 'Open a session first.');
      return ask(`Archive ${titleOf(cur)}? Say yes or cancel.`, async () => { await page.archive(cur.id); strip({ about: `Archived ${titleOf(cur)}.` }); });
    }
    case 'new': {
      const desk = c.desk ? bestMatch(c.desk, page.desks().map((d) => ({ id: d.id, label: d.name }))) : null;
      if (c.desk && !desk) return miss(text, `No desk called "${c.desk}".`);
      const where = desk?.label || page.deskName();
      return ask(`New session in ${where}${c.title ? ` called "${c.title}"` : ''}? Say yes or cancel.`, async () => {
        await page.startDraft({ desk: desk?.id, title: c.title });
        strip({ about: 'New session ready: say "tell it" and what to do, or type it.' });
      });
    }
    default: return miss(text);
  }
}
function miss(text, why = '') {
  strip({ heard: text, about: why || "Didn't catch a command.", sendAs: !why && !!page.current() });
  if (why) speak([why]);
}

// ---------- reading aloud ----------
function voice() {
  const vs = speechSynthesis.getVoices(), want = settings().voice;
  return vs.find((v) => v.name === want) || vs.find((v) => v.localService && v.default && /^en/i.test(v.lang)) || vs.find((v) => v.localService && /^en/i.test(v.lang)) || vs.find((v) => v.localService) || null;
}
export function speak(parts) {
  if (!st.locked || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const v = voice();
  for (const p of parts.filter(Boolean)) { // one utterance each: long ones get cut off in some browsers
    const u = new SpeechSynthesisUtterance(p);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = settings().rate;
    speechSynthesis.speak(u);
  }
}
export function stopSpeaking() { if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) speechSynthesis.cancel(); }
function readReply(asked) {
  const cur = page.current(), text = page.lastReply();
  if (!text) { if (asked) { strip({ about: 'No reply to read yet.' }); speak(['No reply to read yet.']); } return; }
  const { head, rest } = speakable(text);
  st.reading = { rest };
  speak([`${titleOf(cur)}.`, ...head, rest.length ? 'Say more for the rest.' : '']);
  if (asked) strip({ about: `Reading ${titleOf(cur)}.` });
}
// The open session's turn ended: read it, when talk mode is on here and reading is on.
export function turnEnded(id) {
  if (!st.on || !st.locked || !settings().read || page.current()?.id !== id) return;
  readReply(false);
}

// ---------- the strip above the typing box, and the 🎙 button ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function strip({ heard, about, confirm = false, sendAs = false, kind = '' } = {}) {
  if (!st.on) return;
  if (heard !== undefined) $('talkHeard').textContent = heard;
  $('talkHeardRow').hidden = !$('talkHeard').textContent;
  $('talkAbout').textContent = about || '';
  $('talkAbout').className = 'talk-about' + (kind ? ' ' + kind : '');
  $('talkYes').hidden = !confirm; $('talkCancel').hidden = !confirm;
  $('talkSendAs').hidden = !sendAs;
  $('talkAboutRow').hidden = !about && !confirm && !sendAs;
}
function showListening(level) {
  $('talkState').textContent = 'Listening…'; $('talkState').classList.add('on');
  $('talkBtn').classList.add('listening');
  $('talkLevel').hidden = false; $('talkLevel').firstElementChild.style.width = Math.round(level * 100) + '%';
}
function showIdle(note = '') {
  $('talkBtn').classList.remove('listening');
  $('talkLevel').hidden = true;
  $('talkState').classList.remove('on');
  $('talkState').textContent = !st.locked ? 'Talk mode is on in another Docket tab' : st.ready ? `Hold ${keyName()} to talk` : st.loadP ? 'Getting the speech model…' : `Hold ${keyName()} to talk`;
  if (note) strip({ about: note });
}
function showLoading(loaded, total) {
  if (!total || st.ready) return;
  $('talkState').textContent = `Getting the speech model (once): ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`;
}

export async function setOn(on) {
  if (on === st.on) return;
  st.on = on; set('on', on);
  $('talkBtn').setAttribute('aria-pressed', String(on));
  $('talkBtn').title = page.tipText('talk-btn', on);
  $('talkStrip').hidden = !on;
  if (!on) { st.pending = null; stopRec(false); stopSpeaking(); st.releaseLock?.(); st.releaseLock = null; st.locked = false; return; }
  strip({ heard: '', about: '' });
  // One tab at a time: the lock is held for as long as talk mode is on here, and handed on when this tab closes.
  if (navigator.locks) {
    st.locked = false; showIdle();
    navigator.locks.request('docket-talk', () => new Promise((release) => {
      if (!st.on) { release(); return; }
      st.locked = true; st.releaseLock = release; showIdle(); loadModel();
    }));
  } else { st.locked = true; loadModel(); }
  showIdle();
}

// The key: held, it listens; any other key while it is held means it was a shortcut, so nothing is kept.
function onKeyDown(e) {
  if (!st.on || !st.locked) return;
  if (e.code === settings().key) {
    if (e.repeat) return;
    if (!page.canListen()) { strip({ about: 'Close the open window first, then hold the key again.' }); return; }
    startRec(); return;
  }
  if (st.rec) stopRec(false);
}
function onKeyUp(e) { if (st.rec && e.code === settings().key) stopRec(true); }

// 🎙: a short press turns talk mode on or off; held, it talks (turning talk mode on first if needed).
function wireButton(b, toggles) {
  let timer = null, holding = false;
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    b.setPointerCapture?.(e.pointerId);
    timer = setTimeout(async () => { timer = null; holding = true; if (!st.on) await setOn(true); if (st.locked) startRec(); }, toggles ? HOLD_MS : 0);
  });
  const up = () => {
    if (timer) { clearTimeout(timer); timer = null; if (toggles) setOn(!st.on); }
    else if (holding) { holding = false; stopRec(true); }
  };
  b.addEventListener('pointerup', up); b.addEventListener('pointercancel', () => { clearTimeout(timer); timer = null; if (holding) { holding = false; stopRec(false); } });
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (toggles) setOn(!st.on); } });
}

async function openSettings() {
  const s = settings();
  const vs = (window.speechSynthesis?.getVoices() || []).filter((v) => /^en/i.test(v.lang) || v.localService);
  const opt = (v, label, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
  const last = st.stats.slice(-5);
  const body = `<div class="talk-set">
    <label>Push-to-talk key <select id="tsKey"${page.tip('talk-key')}>${keys().map(([k, n]) => opt(k, n, s.key)).join('')}</select></label>
    <label>Speech model <select id="tsModel"${page.tip('talk-model')}>${opt('base', `Quicker (${SIZES.base.webgpu} MB; ${SIZES.base.wasm} MB on the processor)`, s.model)}${opt('small', `Hears names better (${SIZES.small.webgpu} MB; ${SIZES.small.wasm} MB on the processor)`, s.model)}</select></label>
    <label>Run it on <select id="tsDevice"${page.tip('talk-device')}>${opt('auto', 'Graphics card when there is one', s.device)}${opt('wasm', 'Processor only', s.device)}</select></label>
    <label><input type="checkbox" id="tsRead"${s.read ? ' checked' : ''}${page.tip('talk-read')}> Read each reply in the open session aloud</label>
    <label>Voice <select id="tsVoice"${page.tip('talk-voice')}>${opt('', 'This computer\'s default', s.voice)}${vs.map((v) => opt(v.name, `${v.name}${v.localService ? '' : ' (online: the text goes to its maker)'}`, s.voice)).join('')}</select></label>
    <label>Speed <select id="tsRate"${page.tip('talk-rate')}>${[0.9, 1, 1.1, 1.25, 1.5].map((r) => opt(r, r + '×', s.rate)).join('')}</select></label>
    <div class="talk-note">Audio stays on this computer: the speech model runs in this page, and only text you choose to send goes to a session.${st.ready ? ` The model runs on the ${st.device === 'webgpu' ? 'graphics card (WebGPU)' : 'processor (WASM)'}${st.bytes ? `, ${Math.round(st.bytes / 1e6)} MB` : ''}.` : ''}</div>
    ${last.length ? `<div class="talk-note">Last commands: ${last.map((x) => `key up → text ${x.releaseToText} ms, text → done ${x.textToAction ?? '…'} ms`).join(' · ')}</div>` : ''}
  </div>`;
  if (await page.dialog({ title: 'Talk mode', body, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }] }) !== 'save') return;
  // The closed dialog keeps its fields until the next one opens.
  const v = { key: $('tsKey').value, model: $('tsModel').value, device: $('tsDevice').value, read: $('tsRead').checked, voice: $('tsVoice').value, rate: Number($('tsRate').value) };
  for (const [k, x] of Object.entries(v)) set(k, x);
  if (st.on && st.locked) loadModel();
  showIdle();
}

export function start(p) {
  page = p; $ = (id) => document.getElementById(id);
  wireButton($('talkBtn'), true);
  wireButton($('talkHold'), false);
  $('talkYes').onclick = () => st.pending && act({ kind: 'yes' }, 'Clicked yes');
  $('talkCancel').onclick = () => act({ kind: 'cancel' }, 'Clicked cancel');
  $('talkSendAs').onclick = async () => { const t = st.lastHeard; strip({ about: '' }); if (t) { await page.send(t); strip({ about: `Sent to ${titleOf(page.current())}.` }); } };
  $('talkSettings').onclick = openSettings;
  addEventListener('keydown', onKeyDown, true); addEventListener('keyup', onKeyUp, true);
  addEventListener('blur', () => { if (st.rec) stopRec(false); });
  window.speechSynthesis?.getVoices(); // the list fills in later in some browsers
  if (get('on', false)) setOn(true);
  return { setOn, turnEnded, transcribe, heard, speak, stopSpeaking, stats: st.stats, state: st };
}
