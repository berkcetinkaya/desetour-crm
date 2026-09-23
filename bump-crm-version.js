'use strict';
/**
 * bump-crm-version.js
 * ─────────────────────────────────────────────────────────────────────────
 * The ONE deliberate, manual step that advances the CRM's release
 * counter (crm-version.json). NOT run by build.js, NOT run by `npm test`,
 * NOT run by Vercel's buildCommand — none of those ever write to
 * crm-version.json, only read it (see build-version.js). Running this
 * script (or `npm run release`, which chains it with `node build.js`) is
 * the only way the version advances, so ordinary development — editing
 * code, running the test suite, running a local build to sanity-check a
 * change compiles — can never accidentally bump it, however many times
 * those commands are run.
 *
 * Usage — immediately before committing a real, intentional CRM release:
 *   node bump-crm-version.js && node build.js
 * or:
 *   npm run release
 *
 * Applies DeseTour's own release-counter rule (see
 * build-version.js's incrementCrmVersion): minor +1, and once minor
 * would exceed 50, major +1 with minor reset to 01 instead
 * (…12.50 -> 13.01 -> … -> 13.50 -> 14.01). Never semantic versioning.
 * ─────────────────────────────────────────────────────────────────────────
 */
const { bumpCrmVersion, formatCrmVersion } = require('./build-version');

const { previous, next } = bumpCrmVersion();
console.log(`[version] ${formatCrmVersion(previous.major, previous.minor)} -> ${formatCrmVersion(next.major, next.minor)}`);
