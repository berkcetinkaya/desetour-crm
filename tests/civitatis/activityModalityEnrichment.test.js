'use strict';
/**
 * tests/civitatis/activityModalityEnrichment.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Tour Preparation Intelligence — Phase B3: automatic post-write Civitatis
 * Activity/meal-modality persistence. Tests the new orchestrator
 * (enrichCivitatisActivityModalityForPlan) in isolation, with injected
 * getRules/persist fakes — no real Supabase/network call anywhere in this
 * file. The hand-crafted `plan`/`executed` fixtures below mirror the EXACT
 * shapes writeAdapter.js's planCivitatisIngestion/executeCivitatisIngestionPlan
 * produce (plan.plans[j].callMeta parallel to executed[j].calls, 1:1 index
 * alignment) — see writeAdapterCallMeta tests below for proof that the real
 * planner actually produces this shape.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { enrichCivitatisActivityModalityForPlan, ENRICHABLE_RESULTS } = require('../../api/_civitatis/activityModalityEnrichment');
const { planCivitatisIngestion } = require('../../api/_civitatis/writeAdapter');
const { createFakeRepo } = require('./fakeRepo');
const fixtures = require('./fixtures');

const SOURCE_ID = 'src-civitatis-1';
const TOUR_ID = 'tour-grand-bazaar-1';

const PT_RULES = [
  { id: 'rule-contains-com-almoco', language_code: 'pt', match_type: 'contains', match_text: 'com almoço', meal_status: 'included', is_active: true },
  { id: 'rule-contains-sem-almoco', language_code: 'pt', match_type: 'contains', match_text: 'sem almoço', meal_status: 'not_included', is_active: true },
  { id: 'rule-suffix-tour-com', language_code: 'pt', match_type: 'suffix_exact', match_text: 'Visita guiada pela Istambul imprescindível - Tour com', meal_status: 'included', is_active: true },
  { id: 'rule-suffix-tour-sem', language_code: 'pt', match_type: 'suffix_exact', match_text: 'Visita guiada pela Istambul imprescindível - Tour sem', meal_status: 'not_included', is_active: true },
];

function makeGetRules(rulesByLanguage) {
  const calls = [];
  const fn = async ({ languageCode }) => {
    calls.push(languageCode);
    return rulesByLanguage[languageCode] || [];
  };
  fn.calls = calls;
  return fn;
}

function makePersist(results) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return results || { result: 'updated', reservation_id: args.reservationId, meal_status: args.mealStatus };
  };
  fn.calls = calls;
  return fn;
}

function entry({ externalBookingId = 'A1', callMeta, eligible = true }) {
  return { externalBookingId, eligible, callMeta };
}

function resultEntry({ externalBookingId = 'A1', skipped = false, calls }) {
  return { externalBookingId, skipped, calls };
}

function rpcCall({ gmailMessageId, result, reservationId = 'res-1' }) {
  return { gmailMessageId, rpcResult: { result, reservation_id: result === 'manual_review_required' ? undefined : reservationId }, unknownResult: false };
}

// ── 1-2-3: new booking, three language families ────────────────────────

test('1: new booking (Italian), no matching rules -> persists exact raw Activity, meal_status=unknown', async () => {
  const activity = 'Tour del Grande Bazar - Tour in italiano';
  const plan = { civitatisSourceId: SOURCE_ID, plans: [entry({ callMeta: [{ activityName: activity, languageCode: 'it' }] })] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'created' })] })];
  const getRules = makeGetRules({});
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules, persist });

  assert.equal(persist.calls.length, 1);
  assert.equal(persist.calls[0].purchasedActivityRaw, activity);
  assert.equal(persist.calls[0].mealStatus, 'unknown');
  assert.equal(persist.calls[0].reservationId, 'res-1');
  assert.equal(persist.calls[0].sourceId, SOURCE_ID);
});

test('2: new booking (Spanish), no matching rules -> persists exact raw Activity, meal_status=unknown', async () => {
  const activity = 'Tour por el Gran Bazar - Tour en español';
  const plan = { civitatisSourceId: SOURCE_ID, plans: [entry({ callMeta: [{ activityName: activity, languageCode: 'es' }] })] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'created' })] })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({}), persist });

  assert.equal(persist.calls[0].purchasedActivityRaw, activity);
  assert.equal(persist.calls[0].mealStatus, 'unknown');
});

test('3: new booking (Portuguese), matching suffix_exact rule -> persists exact raw Activity, meal_status=included', async () => {
  const activity = 'Visita guiada pela Istambul imprescindível - Tour com';
  const plan = { civitatisSourceId: SOURCE_ID, plans: [entry({ callMeta: [{ activityName: activity, languageCode: 'pt' }] })] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'created' })] })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: PT_RULES }), persist });

  assert.equal(persist.calls[0].purchasedActivityRaw, activity);
  assert.equal(persist.calls[0].mealStatus, 'included');
});

// ── 4-5: modification changing modality either direction ───────────────

test('4: modification changes Tour sem (not_included) -> Tour com (included), both calls persisted correctly', async () => {
  const semActivity = 'Visita guiada pela Istambul imprescindível - Tour sem';
  const comActivity = 'Visita guiada pela Istambul imprescindível - Tour com';
  const plan = {
    civitatisSourceId: SOURCE_ID,
    plans: [entry({ callMeta: [{ activityName: semActivity, languageCode: 'pt' }, { activityName: comActivity, languageCode: 'pt' }] })],
  };
  const executed = [resultEntry({
    calls: [rpcCall({ gmailMessageId: 'm1', result: 'created', reservationId: 'res-9' }), rpcCall({ gmailMessageId: 'm2', result: 'updated', reservationId: 'res-9' })],
  })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: PT_RULES }), persist });

  assert.equal(persist.calls.length, 2);
  assert.equal(persist.calls[0].mealStatus, 'not_included');
  assert.equal(persist.calls[0].purchasedActivityRaw, semActivity);
  assert.equal(persist.calls[1].mealStatus, 'included');
  assert.equal(persist.calls[1].purchasedActivityRaw, comActivity);
});

test('5: modification changes Tour com (included) -> Tour sem (not_included)', async () => {
  const comActivity = 'Visita guiada pela Istambul imprescindível - Tour com';
  const semActivity = 'Visita guiada pela Istambul imprescindível - Tour sem';
  const plan = {
    civitatisSourceId: SOURCE_ID,
    plans: [entry({ callMeta: [{ activityName: comActivity, languageCode: 'pt' }, { activityName: semActivity, languageCode: 'pt' }] })],
  };
  const executed = [resultEntry({
    calls: [rpcCall({ gmailMessageId: 'm1', result: 'created' }), rpcCall({ gmailMessageId: 'm2', result: 'updated' })],
  })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: PT_RULES }), persist });

  assert.equal(persist.calls[0].mealStatus, 'included');
  assert.equal(persist.calls[1].mealStatus, 'not_included');
});

// ── 6: modification with no Activity -> preserve existing state ────────

test('6: modification with no Activity in that event -> persistence RPC is NOT called for that event (existing state untouched)', async () => {
  const comActivity = 'Visita guiada pela Istambul imprescindível - Tour com';
  const plan = {
    civitatisSourceId: SOURCE_ID,
    plans: [entry({ callMeta: [{ activityName: comActivity, languageCode: 'pt' }, { activityName: null, languageCode: 'pt' }] })],
  };
  const executed = [resultEntry({
    calls: [rpcCall({ gmailMessageId: 'm1', result: 'created' }), rpcCall({ gmailMessageId: 'm2', result: 'updated' })],
  })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: PT_RULES }), persist });

  // Only the first (new booking) call, which HAD an Activity, is persisted.
  // The second (modification) call, which had none, must never reach
  // persist — not even with a null/unknown overwrite.
  assert.equal(persist.calls.length, 1);
  assert.equal(persist.calls[0].purchasedActivityRaw, comActivity);
});

test('6b: modification with a blank-string Activity is also treated as missing (never persisted as an empty string)', async () => {
  const plan = { civitatisSourceId: SOURCE_ID, plans: [entry({ callMeta: [{ activityName: '   ', languageCode: 'pt' }] })] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'updated' })] })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: PT_RULES }), persist });

  assert.equal(persist.calls.length, 0);
});

// ── 7: cancellation -> never reached (structural proof) ────────────────

test('7: cancellation events are structurally unreachable — the enrichment hook is only ever called with the booking plan, never the cancellation plan', () => {
  const implSource = fs.readFileSync(require.resolve('../../api/ingest-civitatis-write.js'), 'utf8');
  const codeLines = implSource.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
  });
  const code = codeLines.join('\n');
  const callSite = code.match(/enrichCivitatisActivityModalityForPlan\(\{[^}]*\}\)/);
  assert.ok(callSite, 'expected a call site for enrichCivitatisActivityModalityForPlan');
  assert.doesNotMatch(callSite[0], /cancellation/i);
  assert.match(callSite[0], /\bplan\b/);
  assert.match(callSite[0], /\bexecuted\b/);
});

// ── 8: duplicate/already-processed -> no unnecessary call ──────────────

test('8: already_processed result -> persist is never called', async () => {
  const plan = { civitatisSourceId: SOURCE_ID, plans: [entry({ callMeta: [{ activityName: 'Some Activity', languageCode: 'it' }] })] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'already_processed' })] })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({}), persist });

  assert.equal(persist.calls.length, 0);
});

test('8b: an ineligible (skipped) plan entry -> persist is never called', async () => {
  const plan = { civitatisSourceId: SOURCE_ID, plans: [{ externalBookingId: 'A1', eligible: false, reason: 'needs_review' }] };
  const executed = [{ externalBookingId: 'A1', skipped: true, reason: 'needs_review' }];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({}), persist });

  assert.equal(persist.calls.length, 0);
});

// ── 9: rule-repository failure after successful domain write ───────────

test('9: a rule-repository load failure is isolated — does not throw, other calls still process', async () => {
  const plan = {
    civitatisSourceId: SOURCE_ID,
    plans: [entry({ callMeta: [{ activityName: 'Activity A', languageCode: 'pt' }, { activityName: 'Activity B', languageCode: 'pt' }] })],
  };
  const executed = [resultEntry({
    calls: [rpcCall({ gmailMessageId: 'm1', result: 'created', reservationId: 'res-a' }), rpcCall({ gmailMessageId: 'm2', result: 'created', reservationId: 'res-b' })],
  })];
  let callCount = 0;
  const getRules = async () => {
    callCount += 1;
    if (callCount === 1) throw new Error('Supabase connection reset');
    return [];
  };
  const persist = makePersist();
  const errors = [];

  await assert.doesNotReject(() =>
    enrichCivitatisActivityModalityForPlan({ plan, executed, getRules, persist, onError: (err, ctx) => errors.push({ err, ctx }) })
  );

  assert.equal(errors.length, 1);
  assert.match(errors[0].err.message, /Supabase connection reset/);
  // The booking write itself is never un-committed by this — only the
  // persistence call for that one event was skipped; the next event in
  // the SAME executed array still ran normally.
  assert.equal(persist.calls.length, 1);
  assert.equal(persist.calls[0].reservationId, 'res-b');
});

// ── 10: persistence RPC failure after successful domain write ──────────

test('10: a persistence RPC failure is isolated — does not throw, booking write result is unaffected', async () => {
  const plan = {
    civitatisSourceId: SOURCE_ID,
    plans: [entry({ callMeta: [{ activityName: 'Activity A', languageCode: 'pt' }, { activityName: 'Activity B', languageCode: 'pt' }] })],
  };
  const executed = [resultEntry({
    calls: [rpcCall({ gmailMessageId: 'm1', result: 'created', reservationId: 'res-a' }), rpcCall({ gmailMessageId: 'm2', result: 'created', reservationId: 'res-b' })],
  })];
  let callCount = 0;
  const persist = async (args) => {
    callCount += 1;
    if (callCount === 1) throw new Error('set_reservation_activity_modality RPC failed');
    return { result: 'updated' };
  };
  const errors = [];

  const before = JSON.stringify(executed);
  await assert.doesNotReject(() =>
    enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: PT_RULES }), persist, onError: (err, ctx) => errors.push({ err, ctx }) })
  );
  const after = JSON.stringify(executed);

  assert.equal(errors.length, 1);
  assert.match(errors[0].err.message, /set_reservation_activity_modality RPC failed/);
  // executed (the booking write's own result) must be byte-for-byte
  // unchanged by an enrichment failure.
  assert.equal(before, after);
});

// ── 11: conflicting active rules -> exact raw + unknown ─────────────────

test('11: conflicting active rules -> persists exact raw Activity, meal_status=unknown, never guesses', async () => {
  const activity = 'Visita guiada pela Istambul imprescindível - Tour com almoço extra';
  const conflicting = [
    { id: 'rule-a', language_code: 'pt', match_type: 'contains', match_text: 'imprescindível', meal_status: 'included', is_active: true },
    { id: 'rule-b', language_code: 'pt', match_type: 'contains', match_text: 'Tour com', meal_status: 'not_included', is_active: true },
  ];
  const plan = { civitatisSourceId: SOURCE_ID, plans: [entry({ callMeta: [{ activityName: activity, languageCode: 'pt' }] })] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'created' })] })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: conflicting }), persist });

  assert.equal(persist.calls[0].purchasedActivityRaw, activity);
  assert.equal(persist.calls[0].mealStatus, 'unknown');
});

// ── 12: no matching rule -> exact raw + unknown ─────────────────────────

test('12: Activity with no matching active rule -> persists exact raw Activity, meal_status=unknown', async () => {
  const activity = 'Bosforo y Barrio Sultanahmet - Tour em português';
  const plan = { civitatisSourceId: SOURCE_ID, plans: [entry({ callMeta: [{ activityName: activity, languageCode: 'pt' }] })] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'updated' })] })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: PT_RULES }), persist });

  assert.equal(persist.calls[0].purchasedActivityRaw, activity);
  assert.equal(persist.calls[0].mealStatus, 'unknown');
});

// ── 13: exact raw Activity preservation ─────────────────────────────────

test('13: the exact raw Activity string (accents, punctuation, trailing truncation) is preserved verbatim, never rewritten', async () => {
  const activity = 'Visita guiada pela Istambul imprescindível - Tour sem';
  const plan = { civitatisSourceId: SOURCE_ID, plans: [entry({ callMeta: [{ activityName: activity, languageCode: 'pt' }] })] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'created' })] })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: PT_RULES }), persist });

  assert.equal(persist.calls[0].purchasedActivityRaw, activity);
  assert.notEqual(persist.calls[0].purchasedActivityRaw, activity.toLowerCase());
});

// ── 14: stale_ignored is never enriched ─────────────────────────────────

test('14: stale_ignored result -> persist is never called (an older email must never overwrite newer data)', async () => {
  const plan = { civitatisSourceId: SOURCE_ID, plans: [entry({ callMeta: [{ activityName: 'Some Activity', languageCode: 'pt' }] })] };
  const executed = [resultEntry({ calls: [rpcCall({ gmailMessageId: 'm1', result: 'stale_ignored' })] })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: PT_RULES }), persist });

  assert.equal(persist.calls.length, 0);
  assert.ok(!ENRICHABLE_RESULTS.has('stale_ignored'));
});

// ── 15: manual_review_required / failed -> never enriched ──────────────

test('15: manual_review_required and failed results -> persist is never called', async () => {
  const plan = {
    civitatisSourceId: SOURCE_ID,
    plans: [entry({ callMeta: [{ activityName: 'Activity A', languageCode: 'pt' }, { activityName: 'Activity B', languageCode: 'pt' }] })],
  };
  const executed = [resultEntry({
    calls: [rpcCall({ gmailMessageId: 'm1', result: 'manual_review_required' }), rpcCall({ gmailMessageId: 'm2', result: 'failed' })],
  })];
  const persist = makePersist();

  await enrichCivitatisActivityModalityForPlan({ plan, executed, getRules: makeGetRules({ pt: PT_RULES }), persist });

  assert.equal(persist.calls.length, 0);
});

// ── Structural: this module never mentions WhatsApp ─────────────────────

test('this module never mentions anything WhatsApp-related', () => {
  const implSource = fs.readFileSync(require.resolve('../../api/_civitatis/activityModalityEnrichment.js'), 'utf8');
  assert.doesNotMatch(implSource, /whatsapp/i);
});

test('this module never calls .from(...).update(...) directly — only through persistReservationActivityModality', () => {
  const implSource = fs.readFileSync(require.resolve('../../api/_civitatis/activityModalityEnrichment.js'), 'utf8');
  const codeLines = implSource.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
  });
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /\.from\(/);
  assert.doesNotMatch(code, /\.update\(/);
});

// ── writeAdapter.js callMeta: proves the REAL planner produces the shape
// every test above assumes ──────────────────────────────────────────────

test('writeAdapter.planCivitatisIngestion produces callMeta parallel to calls, with the exact parsed activityName/languageCode, for a new+modified chain', async () => {
  const source = { id: SOURCE_ID, slug: 'civitatis' };
  const tourChannels = [{ id: TOUR_ID, source_id: SOURCE_ID, internal_code: 'Grand Bazaar Experience', language: 'Italiano' }];
  const repo = createFakeRepo({ source, tourChannels });

  const plan = await planCivitatisIngestion({ messages: [fixtures.italianRealFormatBooking, fixtures.italianRealFormatModification], repo });
  assert.equal(plan.ok, true);
  assert.equal(plan.plans.length, 1);

  const planned = plan.plans[0];
  assert.equal(planned.eligible, true);
  assert.ok(Array.isArray(planned.callMeta));
  assert.equal(planned.callMeta.length, planned.calls.length);
  assert.equal(planned.callMeta.length, 2);

  assert.equal(planned.callMeta[0].activityName, 'Tour del Grande Bazar - Tour in italiano');
  assert.equal(planned.callMeta[0].languageCode, 'it');
  assert.equal(planned.callMeta[1].activityName, 'Tour del Grande Bazar - Tour in italiano');
  assert.equal(planned.callMeta[1].languageCode, 'it');

  // callMeta is purely additive — every existing `calls` payload field
  // (never containing Activity) remains exactly as before.
  for (const call of planned.calls) {
    assert.equal(Object.prototype.hasOwnProperty.call(call, 'p_activity'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(call, 'activityName'), false);
  }
});

test('writeAdapter.planCivitatisIngestion: callMeta.activityName is null when the parsed event itself had none (fail-closed/ambiguous-tour-match branch)', async () => {
  const source = { id: SOURCE_ID, slug: 'civitatis' };
  const repo = createFakeRepo({ source, tourChannels: [] }); // no tour channels -> ambiguous/unmatched

  const plan = await planCivitatisIngestion({ messages: [fixtures.unknownLanguage], repo });
  // unknownLanguage fails to parse (ok:false, unrecognized language) -> whole booking ineligible, never reaches callMeta at all.
  assert.equal(plan.ok, true);
  assert.equal(plan.plans[0].eligible, false);
});
