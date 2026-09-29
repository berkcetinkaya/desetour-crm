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

// ─────────────────────────────────────────────────────────────────────────
// REAL-FORMAT fixtures — modeled on the actual sanitized ?debugParser=1
// output from the real Civitatis mailbox (all-caps "LABEL: value" for
// some fields, bare "LABEL" / next-line value for others, no colon on
// "CLIENT DETAILS", a "(Contact details)" marker on Surname, and a
// two-line "PEOPLE" value where the second line is price-only). These
// are the fixtures the parser must handle correctly — the earlier
// Title-Case "Label:\nvalue" fixtures above remain valid too, since the
// parser must support both.
// ─────────────────────────────────────────────────────────────────────────

// 10. Spanish new booking, real mixed-case/mixed-colon structure.
const spanishRealFormatBooking = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41659924: Tour por el Gran Bazar',
  gmailMessageId: 'msg-es-real-new-001',
  gmailThreadId: 'thread-41659924',
  receivedAt: '2026-06-01T10:00:00.000Z',
  body: `
ACTIVITY: Tour por el Gran Bazar - Tour en español

RESERVATION NUMBER: 41659924

CITY: Estambul

LANGUAGE: Español

INTERNAL CODE: Grand Bazaar Experience

DATE: Tuesday, september 29, 2026

HOUR: 9:00 (9:00 am)

PEOPLE
4 Adultos x US$ 49.20
US$ 196.80 (9,600 TL )

PASSENGER INFORMATION 1:

Full name
BALUTT, ADRIANA MARIA

PASSENGER INFORMATION 2:

Full name
TOME, ROSANA

PASSENGER INFORMATION 3:

Full name
BENSEÑOR, MARIA ISABEL

PASSENGER INFORMATION 4:

Full name
PEREZ, JUAN CARLOS

RETAIL PRICE
9,600 TL

NET PRICE
7,200 TL

CLIENT DETAILS

NAME: Adriana Maria

SURNAME: Balutt (Contact details)
`,
};

// 11. Italian new booking, real mixed-case/mixed-colon structure. Same
// external booking ID as fixture 12 (the modification below), for the
// chronological new+modified merge test.
const italianRealFormatBooking = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41629692: Tour del Grande Bazar',
  gmailMessageId: 'msg-it-real-new-001',
  gmailThreadId: 'thread-41629692-real',
  receivedAt: '2026-06-01T10:00:00.000Z',
  body: `
ACTIVITY: Tour del Grande Bazar - Tour in italiano

RESERVATION NUMBER: 41629692

CITY: Istanbul

LANGUAGE: Italiano

INTERNAL CODE: Grand Bazaar Experience

DATE: Monday, november 2, 2026

HOUR: 9:00 (9:00 am)

PEOPLE
2 Adulti x € 43.02
€ 86.04 (4,800 TL )

PASSENGER INFORMATION 1:

Full name
ROMANO JUS

PASSENGER INFORMATION 2:

Full name
GRAZIELLA MINETTO

RETAIL PRICE
4,800 TL

NET PRICE
3,600 TL

CLIENT DETAILS

NAME: No Stop Viaggi Di Fam Srl

SURNAME: Neri Francesca (Contact details)
`,
};

// 12. Modification of fixture 11's booking, real mixed structure, with
// Duration and a Modified information / Phone block.
const italianRealFormatModification = {
  from: FROM_CIVITATIS,
  subject: 'Booking A41629692 modified: Tour del Grande Bazar',
  gmailMessageId: 'msg-it-real-mod-001',
  gmailThreadId: 'thread-41629692-real',
  receivedAt: '2026-06-05T10:00:00.000Z',
  body: `
ACTIVITY: Tour del Grande Bazar - Tour in italiano

RESERVATION NUMBER: 41629692

CITY: Istanbul

LANGUAGE: Italiano

INTERNAL CODE: Grand Bazaar Experience

DATE: Monday, november 2, 2026

HOUR: 9:00 (9:00 am)

DURATION: 4 hours

PEOPLE
2 Adulti x € 43.02
€ 86.04 (4,800 TL )

PASSENGER INFORMATION 1:

Full name
ROMANO JUS

PASSENGER INFORMATION 2:

Full name
GRAZIELLA MINETTO

RETAIL PRICE
4,800 TL

NET PRICE
3,600 TL

CLIENT DETAILS

NAME: No Stop Viaggi Di Fam Srl

SURNAME: Neri Francesca (Contact details)

MODIFIED INFORMATION

PHONE

3714261643
`,
};

// 13. Real-format Retail/Net price with an extra non-price line
// ("(2x2400TRY)") immediately following the Retail price value, which
// must NOT affect the parsed amount.
const realFormatRetailWithExtraLine = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41777001: Tour del Grande Bazar',
  gmailMessageId: 'msg-retail-extra-001',
  gmailThreadId: 'thread-41777001',
  receivedAt: '2026-06-01T10:00:00.000Z',
  body: `
ACTIVITY: Tour del Grande Bazar - Tour in italiano

RESERVATION NUMBER: 41777001

CITY: Istanbul

LANGUAGE: Italiano

INTERNAL CODE: Grand Bazaar Experience

DATE: Monday, november 2, 2026

HOUR: 9:00 (9:00 am)

PEOPLE
2 Adulti

RETAIL PRICE
4800.00 TL
(2x2400TRY)

NET PRICE
3600 TL

CLIENT DETAILS

NAME: Someone

SURNAME: Example
`,
};

// 14. Real booking A41474069 — new booking whose booking-contact name is
// "Juan Armas Puente", used by the write-adapter audit to prove this
// specific real booking ID is treated as POSSIBLE_EXISTING_MATCH (never
// auto-written) whenever an existing customer's exact-normalized name
// already matches, exactly like the generic normalizeFullNameForComparison/
// matchCustomerByName unit tests already prove for that name in the
// abstract.
const juanArmasPuenteBooking = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41474069: Tour por el Gran Bazar',
  gmailMessageId: 'msg-es-new-41474069',
  gmailThreadId: 'thread-41474069',
  receivedAt: '2026-04-01T10:00:00.000Z',
  body: `
Activity:
Tour por el Gran Bazar - Tour en español

Reservation number:
41474069

City:
Istanbul

Language:
Español

Internal code:
Grand Bazaar Experience

Date:
Saturday, october 10, 2026

Hour:
9:00

People:
2 Adultos

Passenger information 1:
Juan Armas Puente

Passenger information 2:
Maria Lopez

Retail price:
4,800 TL

Net price:
3,600 TL

Client details:
Name: Juan
Surname: Armas Puente
`,
};

// 15. Real booking A41534177 — a plain, uncontested new booking used by
// the write-adapter audit as one of the "safe create" real booking IDs.
const sampleSafeCreateBooking = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41534177: Tour del Grande Bazar',
  gmailMessageId: 'msg-it-new-41534177',
  gmailThreadId: 'thread-41534177',
  receivedAt: '2026-03-01T10:00:00.000Z',
  body: `
Activity:
Tour del Grande Bazar - Tour in italiano

Reservation number:
41534177

City:
Istanbul

Language:
Italiano

Internal code:
Grand Bazaar Experience

Date:
Friday, october 2, 2026

Hour:
9:00 (9:00 am)

People:
2 Adulti x € 43.02

Passenger information 1:
Full name
MARCO ROSSI

Passenger information 2:
Full name
LUCA BIANCHI

Retail price:
4,800 TL

Net price:
3,600 TL

Client details:
Name: Marco
Surname: Rossi
`,
};

// 16. Real booking A41748096 — the production live-missing-booking
// incident this fixture was added for. Structurally different from
// every fixture above in TWO ways real Civitatis mail has been observed
// to use: passenger lines as the shorter "Passenger N: NAME" (name
// inline, no "Full name" sub-label at all) rather than "Passenger
// information N:" + a separate value line, and the booking contact as a
// headerless top-level "Client name:" / "Surname:" pair rather than a
// "Client details:" block with nested "Name:"/"Surname:" sub-labels.
// Before the fix these two differences made extractClientDetails return
// no name/surname at all, which alone was enough to route the whole
// email to needs_review (see parser.js's "missing Client details"
// check) — silently and permanently, since a needs_review verdict at
// the planning stage never reaches the RPC and therefore never writes
// an email_ingestions row, so the SAME message would be re-fetched and
// re-rejected on every subsequent scheduled run without ever being
// created or reported as a known failure.
const italianA41748096Booking = {
  from: '"Civitatis.com" <notificaciones@civitatis.com>',
  subject: 'New booking A41748096: Tour del Grande Bazar',
  gmailMessageId: 'msg-it-new-41748096',
  gmailThreadId: 'thread-41748096',
  receivedAt: '2026-09-23T13:47:00.000Z',
  body: `Activity: Tour del Grande Bazar - Tour in italiano
Reservation number: 41748096
City: Istanbul
Language: Italiano
Internal code: Grand Bazaar Experience
Date: Thursday, October 1, 2026
Hour: 9:00
People: 2 Adults
Passenger 1: GIANGUGLIELMO DALMONTE
Passenger 2: COLETTE FICCHI
Retail price: 4,800 TL
Net price: 3,600 TL
Client name: Gianguglielmo
Surname: Dalmonte`,
};

// ── Real production booking A41596990: "Bosforo y Barrio Sultanahmet",
// Português, no "Hour:" field at all (this product states no fixed
// check-in time), "Name" + "Last Name" two-sub-label passenger format,
// € symbol-prefixed prices. See the session's diagnosis: this single
// email exposed FOUR simultaneous parser gaps (missing Português
// mapping, HOUR treated as always-required, € symbol-prefixed prices
// unsupported, and a passenger-name bug where the literal label text
// "Name" became the passenger's fullName) — all fixed together.
const portugueseA41596990Booking = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41596990: Bosforo y Barrio Sultanahmet',
  gmailMessageId: 'msg-pt-new-41596990',
  gmailThreadId: 'thread-41596990',
  receivedAt: '2026-09-20T11:05:00.000Z',
  body: `Activity: Bosforo y Barrio Sultanahmet - Tour em português
Reservation number: 41596990
City: Istanbul
Language: Português
Internal code: Bosforo y Barrio Sultanahmet
Date: Monday, october 26, 2026
Duration: 3 hours
People: 2 Adultos
Passenger information 1:
Name
CARLOS ROBERTO
Last Name
LARRUBIA
Passenger information 2:
Name
AMANDA
Last Name
OLIVEIRA
Retail price
€ 205.40
Net price
€ 154.05
Client details
Name: Carlos
Surname: Larrubia
Email: carlos.larrubia@example.com`,
};

// A second real production booking sharing the exact same newly-
// supported shape (Português, no Hour, Name/Last Name passengers, €
// prices) — a different product/date/passenger to confirm the fix
// generalizes rather than being special-cased to A41596990.
const portugueseA41323338Booking = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41323338: Bosforo y Barrio Sultanahmet',
  gmailMessageId: 'msg-pt-new-41323338',
  gmailThreadId: 'thread-41323338',
  receivedAt: '2026-08-11T09:30:00.000Z',
  body: `Activity: Bosforo y Barrio Sultanahmet - Tour em português
Reservation number: 41323338
City: Istanbul
Language: Português
Internal code: Bosforo y Barrio Sultanahmet
Date: Wednesday, august 12, 2026
Duration: 3 hours
People: 1 Adultos
Passenger information 1:
Name
RICARDO
Last Name
MENDES
Retail price
€ 102.70
Net price
€ 77.03
Client details
Name: Ricardo
Surname: Mendes
Email: ricardo.mendes@example.com`,
};

// A third real production booking, same shape, accent-stripped
// "Portugues" language spelling (distinct from "Português" above) —
// confirms both spellings map to the same canonical language.
const portuguesAccentStrippedA41330832Booking = {
  from: FROM_CIVITATIS,
  subject: 'New booking A41330832: Bosforo y Barrio Sultanahmet',
  gmailMessageId: 'msg-pt-new-41330832',
  gmailThreadId: 'thread-41330832',
  receivedAt: '2026-08-14T15:12:00.000Z',
  body: `Activity: Bosforo y Barrio Sultanahmet - Tour em portugues
Reservation number: 41330832
City: Istanbul
Language: Portugues
Internal code: Bosforo y Barrio Sultanahmet
Date: Friday, august 21, 2026
Duration: 3 hours
People: 2 Adultos
Passenger information 1:
Name
JOANA
Last Name
COSTA
Passenger information 2:
Name
PEDRO
Last Name
COSTA
Retail price
€ 205.40
Net price
€ 154.05
Client details
Name: Joana
Surname: Costa
Email: joana.costa@example.com`,
};

// A fourth real production booking family (A38807986, A39762643,
// A39984703, A40446421, A40466869) — same Português/no-fixed-time shape
// as the three above, but the Hour field here is PRESENT rather than
// absent, holding Civitatis's own placeholder sentence "See more
// information in the voucher" instead of a clock time. Confirmed
// verbatim from real production evidence for A40466869: the Activity,
// Language, Internal code, Hour, People, Retail price, and Net price
// lines below are the EXACT real production values. Reservation number,
// City, Date, passenger names, and Client details were NOT part of that
// evidence — those fields are synthetic minimal completions (clearly
// distinct placeholder names/dates, never asserted as the real booking's
// actual values) needed only so the rest of parseCivitatisEmail's
// required-field checks can be satisfied, isolating this fixture's
// purpose to proving the Hour-placeholder rule alone reaches ok:true.
const portugueseA40466869HourPlaceholderBooking = {
  from: FROM_CIVITATIS,
  subject: 'New booking A40466869: Estambul Historica',
  gmailMessageId: 'msg-pt-new-40466869',
  gmailThreadId: 'thread-40466869',
  receivedAt: '2026-07-02T08:40:00.000Z',
  body: `Activity: Visita guiada pela Istambul imprescindível
Reservation number: 40466869
City: Istanbul
Language: Português
Internal code: Estambul Historica
Date: Sunday, july 5, 2026
Hour: See more information in the voucher
People: 5 Adults
Passenger information 1:
Name
TEST
Last Name
PASSENGER1
Passenger information 2:
Name
TEST
Last Name
PASSENGER2
Passenger information 3:
Name
TEST
Last Name
PASSENGER3
Passenger information 4:
Name
TEST
Last Name
PASSENGER4
Passenger information 5:
Name
TEST
Last Name
PASSENGER5
Retail price: €683.30
Net price: €512.48
Client details
Name: Test
Surname: Contact
Email: test.contact@example.com`,
};

// A38807986: the real production CANCELLATION test case. The subject
// below is confirmed VERBATIM real production evidence: "Cancellation
// A38807986: Visita guiada pela Istambul imprescindível". The body is a
// minimal, clearly-synthetic placeholder — no real cancellation-email
// body content was provided — since cancellation detection/matching is
// deliberately subject-only (see eventDetector.js/cancellationAdapter.js
// headers): the body is never inspected for cancellation purposes at
// all, so its exact content has no bearing on correctness here.
const civitatisCancellationA38807986 = {
  from: FROM_CIVITATIS,
  subject: 'Cancellation A38807986: Visita guiada pela Istambul imprescindível',
  gmailMessageId: 'msg-pt-cancel-38807986',
  gmailThreadId: 'thread-38807986',
  receivedAt: '2026-07-10T09:00:00.000Z',
  body: 'Your reservation A38807986 has been cancelled.',
};

// A second, independent cancellation email for the SAME booking (a
// distinct Gmail message id) — used to test that TWO separate
// cancellation emails for one booking are each planned independently
// (the RPC's own idempotency/already_cancelled short-circuit is what
// makes reprocessing safe, not any special-casing in the JS planner).
const civitatisCancellationA38807986Duplicate = {
  ...civitatisCancellationA38807986,
  gmailMessageId: 'msg-pt-cancel-38807986-dup',
  receivedAt: '2026-07-10T09:05:00.000Z',
};

// A38807986's companion NEW BOOKING email — clearly-synthetic body (no
// real content was provided for this specific booking's new-booking
// email), used only to test the "cancellation arrives before/alongside
// the original booking" ordering scenario and that the existing
// new_booking pipeline is completely unaffected when a cancellation
// message for the SAME external_booking_id is present in the same
// fetched batch.
const civitatisNewBookingA38807986 = {
  from: FROM_CIVITATIS,
  subject: 'New booking A38807986: Visita guiada pela Istambul imprescindível',
  gmailMessageId: 'msg-pt-new-38807986',
  gmailThreadId: 'thread-38807986',
  receivedAt: '2026-07-09T08:00:00.000Z',
  body: `Activity: Visita guiada pela Istambul imprescindível
Reservation number: 38807986
City: Istanbul
Language: Português
Internal code: Visita guiada Istambul
Date: Sunday, july 12, 2026
Hour: See more information in the voucher
People: 2 Adults
Passenger information 1:
Name
TEST
Last Name
PASSENGER1
Passenger information 2:
Name
TEST
Last Name
PASSENGER2
Retail price: €150.00
Net price: €112.00
Client details
Name: Test
Surname: Contact
Email: test.contact.38807986@example.com`,
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
  spanishRealFormatBooking,
  italianRealFormatBooking,
  italianRealFormatModification,
  realFormatRetailWithExtraLine,
  juanArmasPuenteBooking,
  sampleSafeCreateBooking,
  italianA41748096Booking,
  portugueseA41596990Booking,
  portugueseA41323338Booking,
  portuguesAccentStrippedA41330832Booking,
  portugueseA40466869HourPlaceholderBooking,
  civitatisCancellationA38807986,
  civitatisCancellationA38807986Duplicate,
  civitatisNewBookingA38807986,
};
