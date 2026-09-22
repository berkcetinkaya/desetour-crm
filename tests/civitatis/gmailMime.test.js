'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const gmailClient = require('../../api/_civitatis/gmailClient');
const { parseCivitatisEmail } = require('../../api/_civitatis/parser');

// No network access, no real Gmail mailbox, no Supabase connection
// anywhere in this file — only synthetic Gmail API payload shapes built
// in-memory to exercise the MIME traversal / HTML-to-text conversion.

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function leaf(mimeType, text, extra = {}) {
  return { mimeType, filename: '', body: { data: b64url(text), size: text.length }, ...extra };
}

// A full, realistic Civitatis HTML booking email rendered as nested
// tables — the exact structural shape the real mailbox uses (label in
// one <td>, value in the next row or the adjacent <td>), modeled on the
// sanitized real example values already used elsewhere in this project.
function buildCivitatisHtmlEmail({ reservationNumber = '41534177', includeStrayPriceLine = true } = {}) {
  return `
<html>
<head><style>body { font-family: Arial; } .hidden { display:none; }</style></head>
<body>
<!-- Outlook conditional comment noise -->
<table role="presentation" width="600">
  <tr><td>
    <table>
      <tr><td>Activity:</td></tr>
      <tr><td>Tour del Grande Bazar &middot; Tour&nbsp;in&nbsp;italiano</td></tr>
    </table>
  </td></tr>
  <tr><td>
    <table>
      <tr><td>Reservation number:</td><td>${reservationNumber}</td></tr>
      <tr><td>City:</td><td>Istanbul</td></tr>
      <tr><td>Language:</td><td>Italiano</td></tr>
      <tr><td>Internal code:</td><td>Grand Bazaar Experience</td></tr>
      <tr><td>Date:</td><td>Tuesday, october 6, 2026</td></tr>
      <tr><td>Hour:</td><td>9:00 (9:00 am)</td></tr>
    </table>
  </td></tr>
  <tr><td>
    <table>
      <tr><td colspan="2">People:</td></tr>
      <tr><td colspan="2">2 Adulti x &euro; 42.71</td></tr>
      ${includeStrayPriceLine ? '<tr><td colspan="2">&euro; 85.42 (4,800 TL)</td></tr>' : ''}
    </table>
  </td></tr>
  <tr><td>
    <table>
      <tr><td>Passenger information 1:</td></tr>
      <tr><td>Full name:</td></tr>
      <tr><td><b>FRANCESCA MASOTTI</b></td></tr>
      <tr><td>Passenger information 2:</td></tr>
      <tr><td>Full name:</td></tr>
      <tr><td>MICHELE DEMI</td></tr>
    </table>
  </td></tr>
  <tr><td>
    <table>
      <tr><td>Retail price:</td><td>4,800 TL</td></tr>
      <tr><td>Net price:</td><td>3,600 TL</td></tr>
    </table>
  </td></tr>
  <tr><td>
    <table>
      <tr><td>Client details:</td></tr>
      <tr><td>Name: Francesca</td></tr>
      <tr><td>Surname: Masotti</td></tr>
    </table>
  </td></tr>
</table>
<script>var trackingPixel = "should never appear in output";</script>
</body>
</html>`;
}

// ── 1. Top-level text/plain Gmail payload ──────────────────────────────
test('extracts body from a top-level (non-multipart) text/plain payload', () => {
  const payload = leaf('text/plain', 'Reservation number:\n41629692\n');
  const body = gmailClient.extractPlainTextBody(payload);
  assert.ok(body.includes('41629692'));
});

// ── 2. multipart/alternative with text/plain + text/html ───────────────
test('prefers a meaningful text/plain part over text/html inside multipart/alternative', () => {
  const plainText = 'Reservation number:\n41629692\n'.repeat(3); // long enough to be "meaningful"
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      leaf('text/plain', plainText),
      leaf('text/html', '<p>Reservation number:</p><p>99999999</p>'),
    ],
  };
  const body = gmailClient.extractPlainTextBody(payload);
  assert.ok(body.includes('41629692'));
  assert.ok(!body.includes('99999999'));
});

test('falls back to text/html when the text/plain alternative is a trivial stub', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      leaf('text/plain', 'View in browser'), // too short to be "meaningful"
      leaf('text/html', '<table><tr><td>Reservation number:</td><td>41629692</td></tr></table>'),
    ],
  };
  const body = gmailClient.extractPlainTextBody(payload);
  assert.ok(body.includes('Reservation number:'));
  assert.ok(body.includes('41629692'));
});

// ── 3. HTML-only Civitatis booking email (full pipeline integration) ───
test('a full HTML-only Civitatis booking email converts to a body the parser reads completely', () => {
  const html = buildCivitatisHtmlEmail({ reservationNumber: '41534177' });
  const payload = leaf('text/html', html);
  const body = gmailClient.extractPlainTextBody(payload);

  assert.ok(!body.includes('<'), 'no raw HTML tags should survive');
  assert.ok(!body.includes('should never appear in output'), 'script content must be dropped');

  const message = {
    from: 'Civitatis <notificaciones@civitatis.com>',
    subject: 'New booking A41534177: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-html-001',
    gmailThreadId: 'thread-41534177',
    receivedAt: '2026-06-01T10:00:00.000Z',
  };
  const r = parseCivitatisEmail(message);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '41534177');
  assert.equal(r.city, 'Istanbul');
  assert.equal(r.internalCode, 'Grand Bazaar Experience');
  assert.equal(r.date, '2026-10-06');
  assert.equal(r.time, '09:00');
  assert.equal(r.adultCount, 2);
  assert.deepEqual(r.passengers.map(p => p.fullName), ['FRANCESCA MASOTTI', 'MICHELE DEMI']);
  assert.equal(r.retailAmount, 4800);
  assert.equal(r.retailCurrency, 'TL');
  assert.equal(r.netAmount, 3600);
  assert.equal(r.netCurrency, 'TL');
  assert.equal(r.clientName, 'Francesca');
  assert.equal(r.clientSurname, 'Masotti');
});

// ── 4 / 24. nested multipart/mixed wrapping multipart/alternative,
// reservation content several MIME levels deep ─────────────────────────
test('extracts the body from multipart/mixed > multipart/alternative > text/html, several levels deep', () => {
  const html = buildCivitatisHtmlEmail({ reservationNumber: '41629692' });
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          leaf('text/plain', 'HTML required'), // trivial stub, not meaningful
          leaf('text/html', html),
        ],
      },
      leaf('application/pdf', '', { filename: 'unrelated-attachment.pdf', body: { data: '', size: 0 } }),
    ],
  };
  const body = gmailClient.extractPlainTextBody(payload);
  const message = {
    from: 'Civitatis <notificaciones@civitatis.com>',
    subject: 'New booking A41629692: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-nested-001',
    gmailThreadId: 'thread-41629692',
    receivedAt: '2026-06-01T10:00:00.000Z',
  };
  const r = parseCivitatisEmail(message);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '41629692');
});

// ── 5. Gmail base64url decoding ─────────────────────────────────────────
test('decodes base64url (- and _ substituted for + and /, no padding) correctly', () => {
  const original = 'Reservation number:\nÀccénts & symbols € / ok\n';
  const encoded = Buffer.from(original, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(gmailClient.base64UrlDecode(encoded), original);
});

// ── 6. CRLF normalization ───────────────────────────────────────────────
test('normalizes CRLF line endings to LF without losing lines', () => {
  const payload = leaf('text/plain', 'Reservation number:\r\n41629692\r\nCity:\r\nIstanbul\r\n');
  const body = gmailClient.extractPlainTextBody(payload);
  assert.ok(!body.includes('\r'));
  assert.ok(body.includes('Reservation number:\n41629692'));
});

// ── 7. HTML entities ─────────────────────────────────────────────────────
test('decodes named, decimal, and hex HTML entities', () => {
  const html = '<p>&amp; &lt;tag&gt; &quot;quoted&quot; &#39;apos&#39; &#x20ac;uro &nbsp;space</p>';
  const text = gmailClient.htmlToPlainTextFallback(html);
  assert.ok(text.includes('& <tag> "quoted" \'apos\' €uro'));
});

// ── 8. Accented Unicode characters survive unchanged ────────────────────
test('preserves accented Unicode characters through HTML conversion', () => {
  const html = '<table><tr><td>Client details:</td></tr><tr><td>Name: David</td></tr><tr><td>Surname: Galbarra Goñi</td></tr></table><p>Tour en Español</p>';
  const text = gmailClient.htmlToPlainTextFallback(html);
  assert.ok(text.includes('Galbarra Goñi'));
  assert.ok(text.includes('Español'));
});

// ── 9 / 10. label/value same line vs. separate lines (via parser) ──────
test('parses "Label: value" on the same line and "Label:" / value on separate lines identically', () => {
  const F = require('./fixtures');
  const sameLineBody = F.italianNewBooking.body
    .replace('Reservation number:\n41629692', 'Reservation number: 41629692')
    .replace('City:\nIstanbul', 'City: Istanbul');
  const r = parseCivitatisEmail({ ...F.italianNewBooking, body: sameLineBody });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.externalBookingId, '41629692');
  assert.equal(r.city, 'Istanbul');
});

// ── 11 / 12. repeated "Passenger information N:" sections with "Full name:" ──
test('extracts three repeated Passenger information N sections using colon-terminated "Full name:" sub-labels', () => {
  const body = `
Reservation number:
41629692

Internal code:
Grand Bazaar Experience

Language:
Italiano

Date:
Monday, november 2, 2026

Hour:
9:00 (9:00 am)

People:
3 Adulti

Passenger information 1:
Full name:
ROMANO JUS

Passenger information 2:
Full name:
GRAZIELLA MINETTO

Passenger information 3:
Full name:
MARCO ROSSI

Retail price:
4,800 TL

Net price:
3,600 TL

Client details:
Name: No Stop Viaggi Di Fam Srl
Surname: Neri Francesca
`;
  const r = parseCivitatisEmail({
    from: 'Civitatis <notificaciones@civitatis.com>',
    subject: 'New booking A41629692: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-3pax-001',
    gmailThreadId: 'thread-41629692',
    receivedAt: '2026-06-01T10:00:00.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.passengers.map(p => p.fullName), ['ROMANO JUS', 'GRAZIELLA MINETTO', 'MARCO ROSSI']);
});

// ── 17. booking contact with Name/Surname on separate lines from their labels ──
test('parses Client details Name:/Surname: when each value is on its own following line', () => {
  const body = `
Reservation number:
41629692

Internal code:
Grand Bazaar Experience

Language:
Italiano

Date:
Monday, november 2, 2026

Hour:
9:00 (9:00 am)

People:
2 Adulti

Retail price:
4,800 TL

Net price:
3,600 TL

Client details:
Name:
Francesca

Surname:
Masotti
`;
  const r = parseCivitatisEmail({
    from: 'Civitatis <notificaciones@civitatis.com>',
    subject: 'New booking A41629692: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-client-sep-001',
    gmailThreadId: 'thread-41629692',
    receivedAt: '2026-06-01T10:00:00.000Z',
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.clientName, 'Francesca');
  assert.equal(r.clientSurname, 'Masotti');
});

// ── 20. malformed MIME payload ───────────────────────────────────────────
test('a malformed payload (no recognizable text part, no body data anywhere) yields an empty body rather than throwing', () => {
  const payload = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'application/octet-stream', filename: 'blob.bin', body: {} }] };
  assert.doesNotThrow(() => gmailClient.extractPlainTextBody(payload));
  assert.equal(gmailClient.extractPlainTextBody(payload), '');
  assert.equal(gmailClient.extractPlainTextBody(null), '');
  assert.equal(gmailClient.extractPlainTextBody(undefined), '');
});

// ── 21. empty body flows through to parser as parse_error ──────────────
test('an empty extracted body is reported by the parser as parse_error, not needs_review', () => {
  const payload = leaf('text/plain', '');
  const body = gmailClient.extractPlainTextBody(payload);
  const r = parseCivitatisEmail({
    from: 'Civitatis <notificaciones@civitatis.com>',
    subject: 'New booking A41629692: Tour del Grande Bazar',
    body,
    gmailMessageId: 'msg-empty-001',
    gmailThreadId: 'thread-41629692',
    receivedAt: '2026-06-01T10:00:00.000Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'parse_error');
});

// ── 23. HTML table where labels and values sit in separate <td> elements ──
test('preserves label/value boundaries when they are in separate <td> elements of the same row', () => {
  const html = '<table><tr><td>Reservation number:</td><td>41534177</td></tr><tr><td>City:</td><td>Istanbul</td></tr></table>';
  const text = gmailClient.htmlToPlainTextFallback(html);
  const lines = text.split('\n').filter(l => l.trim());
  assert.deepEqual(lines, ['Reservation number:', '41534177', 'City:', 'Istanbul']);
});

test('does not collapse a table row into one unusable run-on line', () => {
  const html = '<table><tr><td>Language:</td><td>Italiano</td></tr><tr><td>Internal code:</td><td>Grand Bazaar Experience</td></tr><tr><td>Date:</td><td>Tuesday, october 6, 2026</td></tr></table>';
  const text = gmailClient.htmlToPlainTextFallback(html);
  assert.ok(!text.includes('Language: Italiano Internal code:'), 'must not merge separate rows onto one line');
});

// buildMimeStructureDiagnostics: safe debug-mode diagnostics never leak text
test('MIME structure diagnostics report mimeType/length only, never decoded text content', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      leaf('text/plain', 'Reservation number:\n41629692\nClient details:\nName: Secret Person\n'),
      leaf('text/html', '<p>Reservation number:</p><p>41629692</p>'),
    ],
  };
  const tree = gmailClient.buildMimeStructureDiagnostics(payload);
  const serialized = JSON.stringify(tree);
  assert.ok(!serialized.includes('Secret Person'));
  assert.ok(!serialized.includes('41629692'));
  assert.equal(tree.mimeType, 'multipart/alternative');
  assert.equal(tree.parts.length, 2);
  assert.equal(tree.parts[0].mimeType, 'text/plain');
  assert.ok(typeof tree.parts[0].decodedTextLength === 'number' && tree.parts[0].decodedTextLength > 0);
});

test('selectMessageBody reports accurate candidate counts and the selected mime type', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      leaf('text/plain', 'too short'),
      leaf('text/html', buildCivitatisHtmlEmail()),
    ],
  };
  const selection = gmailClient.selectMessageBody(payload);
  assert.equal(selection.plainTextCandidateCount, 1);
  assert.equal(selection.htmlCandidateCount, 1);
  assert.equal(selection.selectedBodyMimeType, 'text/html');
  assert.ok(selection.text.length > 0);
});
