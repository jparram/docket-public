// Talk mode's words (#1105): what a heard sentence asks for, which desk or session a spoken name means, what to read
// aloud from a reply, and the words that prime the speech model. Nothing here touches the page or the microphone.
// No imports: the page loads this file too (GET /talk-grammar.mjs, from talk.mjs), so the rules are the ones tested here.

const NUMBERS = { zero: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

// Lower case, punctuation gone, number words as digits, and "Q 7", "queue seven" or "cue 7" as q7.
export function normalize(text) {
  let t = ` ${String(text || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ')} `;
  t = t.replace(/ (twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety) (one|two|three|four|five|six|seven|eight|nine) /g,
    (m, a, b) => ` ${NUMBERS[a] + NUMBERS[b]} `);
  const qWord = '(?:q|queue|cue|kyu|que|question)';
  t = t.replace(new RegExp(` ${qWord} ?(\\d+|${Object.keys(NUMBERS).join('|')}) `, 'g'), (m, n) => ` q${/\d/.test(n) ? n : NUMBERS[n]} `);
  t = t.replace(new RegExp(` ${qWord} ?(\\d+|${Object.keys(NUMBERS).join('|')}) `, 'g'), (m, n) => ` q${/\d/.test(n) ? n : NUMBERS[n]} `);
  return t.replace(/\s+/g, ' ').trim();
}

// The words the speech model may mishear for a command word, read as the command word.
const SOUNDS_LIKE = [[/^(?:sent|sand|cent|scent)$/, 'send'], [/^(?:merch|merged|merj)$/, 'merge'], [/^(?:reed|red)$/, 'read']];
const fixWord = (w) => { for (const [re, to] of SOUNDS_LIKE) if (re.test(w)) return to; return w; };

const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|go ahead|send|send it|yes send|yes send it|yes please|please do|correct|right)$/;
const NO = /^(?:no|nope|cancel|cancel that|cancel it|never mind|nevermind|forget it|dont|do not|abort|scratch that|clear|clear it)$/;

// The text after a dictation word, taken from what was heard (its own capitals and punctuation), not the normalized form.
function after(raw, words) {
  const re = new RegExp(`^\\W*(?:${words})\\b[\\s,:;.-]*`, 'i');
  const m = String(raw).match(re);
  if (!m) return '';
  const rest = String(raw).slice(m[0].length).trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : '';
}
const DICTATE = 'tell (?:it|them|him|her|the session|claude)(?: that)?|reply(?: with)?|respond(?: with)?|answer(?: with)?|say|dictate|message|write';

// What a heard sentence asks for. ctx.pending: something waits on a spoken yes or cancel, so those words answer it
// first. Returns { kind, ... } (kind 'none' when it is not a command), with risky set on what needs a yes first.
export function parse(raw, ctx = {}) {
  const t = normalize(raw).split(' ').map(fixWord).join(' ');
  if (!t) return { kind: 'none', heard: '' };
  if (ctx.pending && YES.test(t)) return { kind: 'yes' };
  if (ctx.pending && NO.test(t)) return { kind: 'cancel' };
  let m;
  if (/^(?:stop|skip|quiet|hush|be quiet|shut up|stop reading|stop talking|enough|thats enough)$/.test(t)) return { kind: 'stop' };
  if (/^(?:stop|interrupt|halt|abort) (?:the |this )?(?:session|turn|work|it now)$|^interrupt(?: it)?$/.test(t)) return { kind: 'interrupt', risky: true };
  if (/^(?:read|read it|read that|read this|read the (?:reply|answer|last reply)|read again|read it again|read that again|repeat|repeat that|again|say that again|what did it say)$/.test(t)) return { kind: 'read' };
  // Dictation next: "tell it to merge" is a message, not a merge.
  const said = after(raw, DICTATE);
  if (new RegExp(`^(?:${DICTATE})\\b`).test(t) && said) return { kind: 'dictate', text: said };
  if ((m = t.match(/^q(\d+)(?: (.+))?$/))) {
    if (!m[2]) return { kind: 'none', heard: raw };
    // The answer as heard: as many of the last words heard as the answer has once normalized.
    const heardWords = String(raw).trim().split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
    return { kind: 'answer', n: Number(m[1]), text: heardWords.slice(-m[2].split(' ').length).join(' ') || m[2] };
  }
  if (/^(?:send|send it|send that|send the message|send message)$/.test(t)) return { kind: 'send' };
  if (/^(?:cancel|cancel that|cancel it|never mind|nevermind|clear(?: (?:it|that|the box))?|scratch that|forget it)$/.test(t)) return { kind: 'cancel' };
  if (/^(?:merge|merge it|merge that|merge the (?:pull request|pr|branch)|please merge|go ahead and merge)$/.test(t)) return { kind: 'merge', risky: true };
  if (/^(?:archive|close) (?:this|it|this one|this session|the session|that one|that)$|^archive$/.test(t)) return { kind: 'archive', risky: true };
  if (/^(?:more|read more|go on|keep going|continue|continue reading|keep reading|and then|whats next|the rest|read the rest)$/.test(t)) return { kind: 'more' };
  if (/^(?:next|next waiting|next one waiting|next session|next session waiting(?: on me)?|next one|whats waiting|what is waiting|whats next waiting|waiting on me|next on me)$/.test(t)) return { kind: 'next' };
  if ((m = t.match(/^(?:scroll |page |go |go to the |go to |jump to (?:the )?|to the )?(up|down|top|bottom|start|end|beginning)(?: of (?:the )?(?:chat|page|session))?$/))
    && (m[1] === 'top' || m[1] === 'bottom' || m[1] === 'start' || m[1] === 'end' || m[1] === 'beginning' || /^(?:scroll|page)/.test(t))) {
    return { kind: 'scroll', dir: { start: 'top', beginning: 'top', end: 'bottom' }[m[1]] || m[1] };
  }
  if ((m = t.match(/^(?:start (?:a )?)?new session(?: (.*))?$/))) {
    const rest = m[1] || '', cs = (raw.match(/\b(?:called|named|titled)\b[\s,:]*(.*)$/i) || [])[1] || '';
    const deskM = rest.match(/(?:^| )(?:in|on|for) (?:the )?(.+?)(?: desk)?(?= called| named| titled|$)/);
    return { kind: 'new', desk: deskM ? deskM[1].trim() : '', title: cs.replace(/(?:\s+(?:in|on|for)\s+(?:the\s+)?\S+(?:\s+desk)?)$/i, '').replace(/[.!?]+$/, '').trim(), risky: true };
  }
  if ((m = t.match(/^(?:(?:go to|switch to|change to|show|open|take me to) )?(?:the )?(.+?) desk$|^desk (.+)$/))) return { kind: 'desk', name: (m[1] || m[2]).trim() };
  if ((m = t.match(/^(?:open|show(?: me)?|go to|switch to|take me to|jump to|bring up|find)(?: up)? (.+)$/))) {
    const name = m[1].replace(/^the /, '').replace(/^(?:session|chat|one|conversation)(?: (?:about|called|named|on|for|with|titled))? ?/, '').replace(/^(?:about|called|named) /, '').replace(/ (?:session|one|chat)$/, '').trim();
    return name ? { kind: 'open', name } : { kind: 'none', heard: raw };
  }
  return { kind: 'none', heard: raw };
}

// ---------- names ----------
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'in', 'on', 'one', 'session', 'chat', 'about', 'called', 'named', 'desk', 'that', 'this', 'with', 'is', 'it']);
const words = (s) => normalize(s).split(' ').filter((w) => w && !STOP.has(w));
function lev(a, b) {
  if (a === b) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
const wordSim = (a, b) => (a === b ? 1 : (b.startsWith(a) && a.length >= 3) || (a.startsWith(b) && b.length >= 3) ? 0.85 : 1 - lev(a, b) / Math.max(a.length, b.length));

// How well a spoken name fits a label, 0 to 1: each spoken word's best fit among the label's words, averaged, and a
// little more when the words run together in the label ("relay fix" in "Relay fix for the proxy").
export function nameScore(spoken, label) {
  const q = words(spoken), l = words(label);
  if (!q.length || !l.length) return 0;
  const joined = l.join('');
  const per = q.map((w) => Math.max(...l.map((x) => wordSim(w, x)), joined.includes(w) && w.length >= 4 ? 0.8 : 0));
  let s = per.reduce((a, b) => a + b, 0) / q.length;
  if (normalize(label).includes(q.join(' '))) s = Math.min(1, s + 0.1);
  return s;
}

// The best fit for a spoken name among items ({ id, label }), or null when nothing fits well enough.
// close: the runner-up fits nearly as well, so the page says which one it took.
export function bestMatch(spoken, items, min = 0.62) {
  const scored = items.map((it) => ({ ...it, score: nameScore(spoken, it.label) })).filter((x) => x.score >= min).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  return { ...scored[0], close: scored.length > 1 && scored[0].score - scored[1].score < 0.05 ? scored[1] : null };
}

// ---------- reading aloud ----------
// A reply as it reads aloud, from its plain text: code blocks, tables and links shortened, paths as their file name,
// markdown symbols gone. head: the first paragraph and every numbered question line; rest: everything else.
export function speakable(md) {
  const text = String(md || '').replace(/\r/g, '');
  const blocks = [];
  let cur = [], inCode = false, table = 0;
  const flush = () => { if (table) { blocks.push(`A table with ${Math.max(0, table - 2)} row${table - 2 === 1 ? '' : 's'}.`); table = 0; } if (cur.length) { blocks.push(cur.join(' ')); cur = []; } };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { if (!inCode) { flush(); blocks.push('Code block skipped.'); } inCode = !inCode; continue; }
    if (inCode) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) { if (cur.length) { blocks.push(cur.join(' ')); cur = []; } table++; continue; }
    if (table) flush();
    if (!line.trim()) { flush(); continue; }
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || /^\s*#{1,6}\s/.test(line) || /^\s*\**Q\d+\b/.test(line)) { flush(); cur.push(line); flush(); continue; }
    cur.push(line);
  }
  flush();
  const clean = (s) => s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+)+[\\/]([\w.@-]+\.[A-Za-z0-9]{1,6})(?::\d+)?/g, '$1')
    .replace(/(?:^|\s)\.{0,2}\/(?:[\w.@-]+\/)+([\w.@-]+)/g, ' $1')
    .replace(/^\s*#{1,6}\s+/, '').replace(/^\s*>\s?/, '').replace(/^\s*(?:[-*+])\s+/, '')
    .replace(/\*\*|__|~~|(?<!\w)[*_](?!\s)|(?<!\s)[*_](?!\w)/g, '')
    .replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = blocks.map(clean).filter(Boolean);
  const isQ = (s) => /^Q\d+\b/.test(s);
  const firstIdx = parts.findIndex((p) => !isQ(p));
  const head = parts.filter((p, i) => i === firstIdx || isQ(p));
  const rest = parts.filter((p, i) => !(i === firstIdx || isQ(p)));
  return { head, rest };
}

// ---------- priming ----------
// The words the speech model is primed with: the command words, then desk names and session titles, newest first,
// cut to stay well inside the model's prompt (long prompts make it repeat them back on silence).
export const COMMAND_WORDS = 'Docket. Open, next waiting, scroll down, read it, more, stop, Q7 yes, tell it, send, cancel, merge, archive this one, new session.';
export function primeText(desks = [], titles = [], max = 400) {
  let out = COMMAND_WORDS;
  const add = (label, list) => {
    const names = [...new Set(list.map((x) => String(x || '').replace(/\s+/g, ' ').trim()).filter((x) => x && x.length <= 60))];
    let part = '';
    for (const n of names) { const next = part ? `${part}, ${n}` : n; if (out.length + label.length + next.length + 3 > max) break; part = next; }
    if (part) out += ` ${label}: ${part}.`;
  };
  add('Desks', desks); add('Sessions', titles);
  return out;
}

// What is heard when the model hears nothing: Whisper answers silence and noise with a few stock phrases.
export const isNoise = (t) => !normalize(t) || /^(?:\[?\s*(?:blank_audio|silence|music|inaudible|no speech)\s*\]?|thank you|thanks for watching|you|bye)\.?$/i.test(String(t).trim().replace(/[()[\]]/g, ''));
