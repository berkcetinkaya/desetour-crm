'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildParserRelevantLines, redactSensitiveText } = require('../../api/civitatis/parserDiagnostics');

test('redacts email addresses and URLs, leaving other text untouched', () => {
  const text = 'Contact us at reservations@civitatis.com or visit https://civitatis.com/help now';
  const redacted = redactSensitiveText(text);
  assert.ok(!redacted.includes('reservations@civitatis.com'));
  assert.ok(!redacted.includes('https://civitatis.com/help'));
  assert.ok(redacted.includes('[redacted-email]'));
  assert.ok(redacted.includes('[redacted-url]'));
  assert.ok(redacted.includes('Contact us at'));
});

test('picks up lines matching booking-field keywords plus one line of context on each side', () => {
  const body = [
    /* 1 */ 'Dear partner,',
    /* 2 */ '',
    /* 3 */ 'Reservation number:',
    /* 4 */ '41629692',
    /* 5 */ '',
    /* 6 */ 'Thank you for choosing Civitatis.',
  ].join('\n');
  const lines = buildParserRelevantLines(body);
  const lineNumbers = lines.map(l => l.lineNumber);
  // The matched label line (3), its value context line (4, the next
  // non-empty line), and the context line before it (1, the nearest
  // non-empty line above) are all included.
  assert.ok(lineNumbers.includes(3));
  assert.ok(lineNumbers.includes(4));
  assert.ok(lineNumbers.includes(1));
  assert.equal(lines.find(l => l.lineNumber === 3).text, 'Reservation number:');
  assert.equal(lines.find(l => l.lineNumber === 4).text, '41629692');
});

test('never includes an unrelated line that has no keyword and is not adjacent to a match', () => {
  const body = [
    /* 1 */ 'Unrelated marketing paragraph one.',
    /* 2 */ 'Unrelated marketing paragraph two.',
    /* 3 */ 'Reservation number:',
    /* 4 */ '41629692',
    /* 5 */ 'Unrelated marketing paragraph three.',
    /* 6 */ 'Unrelated marketing paragraph four.',
  ].join('\n');
  const lines = buildParserRelevantLines(body);
  const lineNumbers = lines.map(l => l.lineNumber).sort((a, b) => a - b);
  // Only line 3 matches a keyword; its context is the nearest non-empty
  // line above (2) and below (4) — lines 1, 5, and 6 are never reached.
  assert.deepEqual(lineNumbers, [2, 3, 4]);
});

test('redacts an email address that only appears as context next to a Name/Surname match', () => {
  const body = [
    'Client details:',
    'Name: Francesca',
    'Surname: Masotti',
    'Email: francesca.masotti@example.com',
  ].join('\n');
  const lines = buildParserRelevantLines(body);
  const serialized = JSON.stringify(lines);
  assert.ok(!serialized.includes('francesca.masotti@example.com'));
});

test('returns an empty array for a body with no diagnostic keywords at all', () => {
  assert.deepEqual(buildParserRelevantLines('Just a generic unrelated message with no booking data.'), []);
  assert.deepEqual(buildParserRelevantLines(''), []);
  assert.deepEqual(buildParserRelevantLines(null), []);
});
