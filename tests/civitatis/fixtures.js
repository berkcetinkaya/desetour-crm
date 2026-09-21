/**
 * tests/civitatis/fixtures.js
 * ─────────────────────────────────────────────────────────────────────────
 * Sanitized fixture messages modeled on the real Civitatis emails
 * inspected for this integration. Names/numbers are the same illustrative
 * values already shared for this project (not real production traveler
 * data) — used only to exercise the deterministic parser and dry-run
 * logic offline. No network access, no Supabase access, no real Gmail
 * mailbox involved anywhere in this file or in anything that consumes it.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const FROM_CIVITATIS = 'Civitatis <notificaciones@civitatis.com>';
const FROM_OTHER = 'Someone Else <someone@example.com>';

// 1. Italian new booking
const italianNewBooking = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41629692: Tour del Grande Bazar',
  gmailMessageId: 'msg-it-new-001',
  gmailThreadId: 'thread-41629692',
  receivedAt: '2026-06-01T10:00:00.000Z',
  body: `
Activity:
Tour del Grande Bazar - Tour in italiano

Reservation number:
41629692

City:
Istanbul

Language:
Italiano

Internal code:
Grand Bazaar Experience

Date:
Monday, november 2, 2026

Hour:
9:00 (9:00 am)

People:
2 Adulti x € 43.02

Passenger information 1:
Full name
ROMANO JUS

Passenger information 2:
Full name
GRAZIELLA MINETTO

Retail price:
4,800 TL

Net price:
3,600 TL

Client details:
Name: No Stop Viaggi Di Fam Srl
Surname: Neri Francesca

The booking has been confirmed automatically.
`,
};

// 2. Italian modification for the SAME reservation number
const italianModification = {
  from: FROM_CIVITATIS,
  subject: 'Booking A41629692 modified: Tour del Grande Bazar',
  gmailMessageId: 'msg-it-mod-001',
  gmailThreadId: 'thread-41629692',
  receivedAt: '2026-06-05T10:00:00.000Z',
  body: `
Activity:
Tour del Grande Bazar - Tour in italiano

Reservation number:
41629692

City:
Istanbul

Language:
Italiano

Internal code:
Grand Bazaar Experience

Date:
Monday, november 2, 2026

Hour:
9:00 (9:00 am)

Duration:
4 hours

People:
2 Adulti x € 43.02

Passenger information 1:
Full name
ROMANO JUS

Passenger information 2:
Full name
GRAZIELLA MINETTO

Retail price:
4,800 TL

Net price:
3,600 TL

Client details:
Name: No Stop Viaggi Di Fam Srl
Surname: Neri Francesca

Modified information
Phone
3714261643
3405557310
`,
};

// 3. Spanish new booking
const spanishNewBooking = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41576789: Tour por el Gran Bazar',
  gmailMessageId: 'msg-es-new-001',
  gmailThreadId: 'thread-41576789',
  receivedAt: '2026-05-01T10:00:00.000Z',
  body: `
Activity:
Tour por el Gran Bazar - Tour en español

Reservation number:
41576789

City:
Istanbul

Language:
Español

Internal code:
Grand Bazaar Experience

Date:
Saturday, september 26, 2026

Hour:
9:00

People:
2 Adultos

Passenger information 1:
David Galbarra Goñi

Passenger information 2:
Itsaso Zalba Marcos

Retail price:
4,800 TL

Net price:
3,600 TL

Client details:
Name: David
Surname: Galbarra Goñi
`,
};

// 4. Irrelevant Civitatis invoice email — must be ignored, never parsed
const invoiceEmail = {
  from: FROM_CIVITATIS,
  subject: 'Invoice requested for booking A41629692',
  gmailMessageId: 'msg-invoice-001',
  gmailThreadId: 'thread-invoice-001',
  receivedAt: '2026-06-02T10:00:00.000Z',
  body: 'Dear partner, an invoice has been requested for the above booking. Please find attached...',
};

// 5. Irrelevant marketing / account-manager email — must be ignored
const marketingEmail = {
  from: FROM_CIVITATIS,
  subject: 'New activity available in Civitatis',
  gmailMessageId: 'msg-marketing-001',
  gmailThreadId: 'thread-marketing-001',
  receivedAt: '2026-06-03T10:00:00.000Z',
  body: 'Great news! A new activity category is now available for partners to list...',
};

// 6. Malformed / unsupported booking subject (looks booking-related, no
// supported pattern matches — e.g. a hypothetical cancellation subject)
const malformedBookingSubject = {
  from: FROM_CIVITATIS,
  subject: 'Booking A41629692 cancelled: Tour del Grande Bazar',
  gmailMessageId: 'msg-malformed-001',
  gmailThreadId: 'thread-41629692',
  receivedAt: '2026-06-06T10:00:00.000Z',
  body: 'This booking has been cancelled.',
};

// 7. Missing Internal code
const missingInternalCode = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41629700: Tour del Grande Bazar',
  gmailMessageId: 'msg-missing-code-001',
  gmailThreadId: 'thread-41629700',
  receivedAt: '2026-06-07T10:00:00.000Z',
  body: `
Activity:
Tour del Grande Bazar - Tour in italiano

Reservation number:
41629700

City:
Istanbul

Language:
Italiano

Date:
Monday, november 2, 2026

Hour:
9:00 (9:00 am)

People:
2 Adulti x € 43.02

Retail price:
4,800 TL

Net price:
3,600 TL

Client details:
Name: Someone
Surname: Example
`,
};

// 8. Unknown language
const unknownLanguage = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41629701: Tour del Grande Bazar',
  gmailMessageId: 'msg-unknown-lang-001',
  gmailThreadId: 'thread-41629701',
  receivedAt: '2026-06-08T10:00:00.000Z',
  body: `
Activity:
Tour del Grande Bazar - Deutsche Tour

Reservation number:
41629701

City:
Istanbul

Language:
Deutsch

Internal code:
Grand Bazaar Experience

Date:
Monday, november 2, 2026

Hour:
9:00 (9:00 am)

People:
2 Adulti x € 43.02

Retail price:
4,800 TL

Net price:
3,600 TL

Client details:
Name: Someone
Surname: Example
`,
};

// 9. Duplicate Gmail message id of fixture #1 — same gmailMessageId,
// otherwise identical to italianNewBooking. Used to test that reprocessing
// the same Gmail message is a no-op.
const duplicateOfItalianNewBooking = {
  ...italianNewBooking,
  receivedAt: '2026-06-01T10:00:01.000Z', // re-fetched a moment later
};

module.exports = {
  FROM_CIVITATIS,
  FROM_OTHER,
  italianNewBooking,
  italianModification,
  spanishNewBooking,
  invoiceEmail,
  marketingEmail,
  malformedBookingSubject,
  missingInternalCode,
  unknownLanguage,
  duplicateOfItalianNewBooking,
};
