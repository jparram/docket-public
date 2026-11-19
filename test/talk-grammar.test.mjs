// Tests for talk mode's words (#1105): commands, spoken names, read-back text and priming. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parse, nameScore, bestMatch, speakable, primeText, isNoise, COMMAND_WORDS } from '../talk-grammar.mjs';

test('normalize: punctuation, number words and Q numbers', () => {
  assert.equal(normalize('Go to the ACME desk.'), 'go to the acme desk');
  assert.equal(normalize('Q7, yes.'), 'q7 yes');
  assert.equal(normalize('Q 12 the second one'), 'q12 the second one');
  assert.equal(normalize('queue seven yes'), 'q7 yes');
  assert.equal(normalize('cue twenty three no'), 'q23 no');
  assert.equal(normalize("What's waiting?"), 'whats waiting');
});

test('navigation commands', () => {
  assert.deepEqual(parse('Go to the Acme desk.'), { kind: 'desk', name: 'acme' });
  assert.deepEqual(parse('Northwind desk'), { kind: 'desk', name: 'northwind' });
  assert.deepEqual(parse('Open the session about relay fix.'), { kind: 'open', name: 'relay fix' });
  assert.deepEqual(parse('Open relay fix'), { kind: 'open', name: 'relay fix' });
  assert.deepEqual(parse('show me the invoice one'), { kind: 'open', name: 'invoice' });
  assert.deepEqual(parse('Next waiting.'), { kind: 'next' });
  assert.deepEqual(parse("What's waiting?"), { kind: 'next' });
  assert.deepEqual(parse('Scroll down.'), { kind: 'scroll', dir: 'down' });
  assert.deepEqual(parse('scroll up'), { kind: 'scroll', dir: 'up' });
  assert.deepEqual(parse('Top.'), { kind: 'scroll', dir: 'top' });
  assert.deepEqual(parse('go to the bottom'), { kind: 'scroll', dir: 'bottom' });
  assert.equal(parse('up').kind, 'none', 'a lone "up" is not a scroll');
});

test('reading commands', () => {
  assert.equal(parse('Read it.').kind, 'read');
  assert.equal(parse('read again').kind, 'read');
  assert.equal(parse('Say that again').kind, 'read', 'not a dictation of "that again"');
  assert.equal(parse('More.').kind, 'more');
  assert.equal(parse('Stop.').kind, 'stop');
  assert.equal(parse('skip').kind, 'stop');
});

test('dictation keeps what was said, with its own capitals', () => {
  assert.deepEqual(parse('Tell it use the second option.'), { kind: 'dictate', text: 'Use the second option.' });
  assert.deepEqual(parse('tell it to merge after the tests pass'), { kind: 'dictate', text: 'To merge after the tests pass' });
  assert.deepEqual(parse('Reply, looks good to me.'), { kind: 'dictate', text: 'Looks good to me.' });
  assert.deepEqual(parse('Tell the session that the API key is in the vault'), { kind: 'dictate', text: 'The API key is in the vault' });
  assert.equal(parse('tell it').kind, 'none', 'nothing to say');
});

test('answers by question number', () => {
  assert.deepEqual(parse('Q7, yes.'), { kind: 'answer', n: 7, text: 'yes.' });
  assert.deepEqual(parse('Q9 the second one'), { kind: 'answer', n: 9, text: 'the second one' });
  assert.deepEqual(parse('queue seven keep the CSV export'), { kind: 'answer', n: 7, text: 'keep the CSV export' });
  assert.equal(parse('Q7').kind, 'none', 'a number with no answer');
});

test('acting commands are risky; send and cancel are not', () => {
  assert.deepEqual(parse('Merge.'), { kind: 'merge', risky: true });
  assert.deepEqual(parse('Merge it'), { kind: 'merge', risky: true });
  assert.deepEqual(parse('Archive this one.'), { kind: 'archive', risky: true });
  assert.deepEqual(parse('Stop the session.'), { kind: 'interrupt', risky: true });
  assert.deepEqual(parse('Send.'), { kind: 'send' });
  assert.deepEqual(parse('sent'), { kind: 'send' }, 'a common mishearing');
  assert.deepEqual(parse('Never mind'), { kind: 'cancel' });
});

test('new session in a desk called a title', () => {
  assert.deepEqual(parse('New session in Acme called invoice cleanup.'), { kind: 'new', desk: 'acme', title: 'invoice cleanup', risky: true });
  assert.deepEqual(parse('New session called Invoice cleanup in Acme'), { kind: 'new', desk: 'acme', title: 'Invoice cleanup', risky: true });
  assert.deepEqual(parse('new session'), { kind: 'new', desk: '', title: '', risky: true });
  assert.deepEqual(parse('Start a new session on the Northwind desk'), { kind: 'new', desk: 'northwind', title: '', risky: true });
});

test('yes and cancel answer what waits first', () => {
  assert.deepEqual(parse('Yes.', { pending: true }), { kind: 'yes' });
  assert.deepEqual(parse('Send', { pending: true }), { kind: 'yes' });
  assert.deepEqual(parse('Go ahead', { pending: true }), { kind: 'yes' });
  assert.deepEqual(parse('No.', { pending: true }), { kind: 'cancel' });
  assert.deepEqual(parse('Yes.'), { kind: 'none', heard: 'Yes.' }, 'nothing waits: not a command');
});

test('anything else is not a command, with what was heard', () => {
  assert.deepEqual(parse('I wonder what the weather is'), { kind: 'none', heard: 'I wonder what the weather is' });
  assert.equal(parse('').kind, 'none');
});

test('spoken names match titles fuzzily', () => {
  const items = [
    { id: 'a', label: 'Relay fix for the proxy' },
    { id: 'b', label: 'Invoice cleanup' },
    { id: 'c', label: '#1082 Research: talk mode by voice' },
    { id: 'd', label: 'Release notes' },
  ];
  assert.equal(bestMatch('relay fix', items).id, 'a');
  assert.equal(bestMatch('the relay one', items).id, 'a');
  assert.equal(bestMatch('invoice clean up', items).id, 'b');
  assert.equal(bestMatch('talk mode', items).id, 'c');
  assert.equal(bestMatch('research', items).id, 'c');
  assert.equal(bestMatch('release notes', items).id, 'd');
  assert.equal(bestMatch('quarterly taxes', items), null);
  assert.ok(nameScore('acme', 'Acme') > 0.95);
  assert.ok(nameScore('acne', 'Acme') >= 0.62, 'one letter misheard still fits');
});

test('speakable: first paragraph and Q lines first, code, tables, links and paths shortened', () => {
  const md = [
    'I fixed the **relay** in `server.mjs`. See [the PR](https://github.com/x/y/pull/1).',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '',
    'The file is at C:\\Work\\acme\\src\\talk.mjs and also https://example.com/page.',
    '',
    '**Q7: Keep the CSV export?**',
    'Q8: Merge now?',
  ].join('\n');
  const { head, rest } = speakable(md);
  assert.deepEqual(head, ['I fixed the relay in server.mjs. See the PR.', 'Q7: Keep the CSV export?', 'Q8: Merge now?']);
  assert.deepEqual(rest, ['Code block skipped.', 'A table with 2 rows.', 'The file is at talk.mjs and also a link']);
});

test('speakable: lists and headings read as their own lines', () => {
  const { head, rest } = speakable('## Done\n\n- one thing\n- *another* thing\n');
  assert.deepEqual(head, ['Done']);
  assert.deepEqual(rest, ['one thing', 'another thing']);
});

test('primeText: command words, then desks and titles, cut short', () => {
  const p = primeText(['Acme', 'Northwind'], ['Relay fix', 'Invoice cleanup', 'Relay fix']);
  assert.equal(p, `${COMMAND_WORDS} Desks: Acme, Northwind. Sessions: Relay fix, Invoice cleanup.`);
  const long = primeText(['Acme'], Array.from({ length: 100 }, (_, i) => `Session number ${i}`));
  assert.ok(long.length <= 400, long.length);
  assert.match(long, /Session number 0/);
});

test('isNoise: what Whisper says for silence', () => {
  for (const t of ['', '[BLANK_AUDIO]', ' (silence) ', 'Thank you.', 'you']) assert.ok(isNoise(t), t);
  assert.ok(!isNoise('Send.'));
});
