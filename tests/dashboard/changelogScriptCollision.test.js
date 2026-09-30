'use strict';
/**
 * tests/dashboard/changelogScriptCollision.test.js
 * ─────────────────────────────────────────────────────────────────────────
 * Regression coverage for a real production incident: crmChangelog.js and
 * app.js (DeseTourDashboard.jsx, Babel-compiled) are both loaded as
 * separate CLASSIC (non-module) <script> tags in index.html. Classic
 * scripts do not get their own lexical scope — every top-level
 * `const`/`let`/`class` across ALL classic scripts on a page lands in ONE
 * shared global lexical environment. crmChangelog.js used to declare
 * `const CRM_CHANGELOG` / `const CRM_CHANGELOG_CATEGORIES` at its own top
 * level AND assign to window.CRM_CHANGELOG/window.CRM_CHANGELOG_CATEGORIES,
 * while DeseTourDashboard.jsx independently declared its OWN top-level
 * `const` of those exact same two names to read them back. The instant
 * app.js loaded after crmChangelog.js, the browser threw:
 *   Uncaught SyntaxError: Identifier 'CRM_CHANGELOG_CATEGORIES' has
 *   already been declared
 * — a page-breaking production outage. This is a *browser parse-time*
 * error with no Node/CommonJS equivalent: a plain `require()` of either
 * file in isolation (as every other test in this suite does) can NEVER
 * reproduce it, because each require() gets its own module scope. This
 * file uses Node's vm module to actually simulate two classic <script>
 * tags sharing one global lexical environment — the same mechanism a
 * real browser uses — so it catches this exact failure mode.
 *
 * The fix: crmChangelog.js now wraps every top-level declaration in an
 * IIFE and exposes its data through exactly ONE property assignment,
 * window.DESETOUR_CHANGELOG = {...} — a property write can never collide
 * with a lexical declaration, by construction. See crmChangelog.js's own
 * header comment for the full explanation.
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CRM_CHANGELOG_PATH = path.join(REPO_ROOT, 'crmChangelog.js');
const APP_JS_PATH = path.join(REPO_ROOT, 'app.js');

/** A minimal but sufficient global stub for parsing+running app.js far
 * enough to get past its own top-level declarations. app.js is a full
 * React app — it will legitimately fail later on missing real DOM/React
 * behavior in a bare vm context, and that is expected and fine; the only
 * thing this test cares about is whether the SyntaxError this incident
 * produced is thrown. */
function makeBrowserLikeContext() {
  const context = {
    console,
    React: {},
    ReactDOM: {},
    navigator: { userAgent: 'node-test' },
    location: { hash: '', href: '' },
    document: {
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      createElement() { return { style: {}, setAttribute() {}, appendChild() {} }; },
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  return context;
}

/** Runs `source` (as a classic, non-module script) in `context`, catching
 * (never letting the caller crash on) any exception, and reports whether
 * that exception was specifically the "Identifier ... has already been
 * declared" SyntaxError this incident produced. */
function runClassicScript(source, filename, context) {
  try {
    vm.runInContext(source, context, { filename });
    return { threw: false };
  } catch (e) {
    // NOT `e instanceof SyntaxError`: vm.createContext() gives the
    // executed code its OWN realm, with its OWN SyntaxError constructor —
    // distinct from this test file's outer-realm SyntaxError. An
    // instanceof check across that boundary is always false even for a
    // real SyntaxError from inside the vm, so this checks e.name (a
    // plain string, safe across realms) plus the message instead.
    return {
      threw: true,
      isDuplicateDeclarationError: e && e.name === 'SyntaxError' && /has already been declared/.test(e.message),
      error: e,
    };
  }
}

// ── The real regression check ───────────────────────────────────────────

test('crmChangelog.js exists and app.js has been built at least once (prerequisite for this test)', () => {
  assert.ok(fs.existsSync(CRM_CHANGELOG_PATH), 'crmChangelog.js not found');
  assert.ok(fs.existsSync(APP_JS_PATH), 'app.js not found — run `node build.js` first');
});

test('loading crmChangelog.js then the REAL built app.js in one shared global scope (simulating two classic <script> tags) never throws a duplicate-declaration SyntaxError', () => {
  const context = makeBrowserLikeContext();
  const crmChangelogSrc = fs.readFileSync(CRM_CHANGELOG_PATH, 'utf8');
  const appJsSrc = fs.readFileSync(APP_JS_PATH, 'utf8');

  const first = runClassicScript(crmChangelogSrc, 'crmChangelog.js', context);
  assert.equal(first.threw, false, `crmChangelog.js itself must load cleanly, got: ${first.error && first.error.message}`);

  const second = runClassicScript(appJsSrc, 'app.js', context);
  if (second.threw && second.isDuplicateDeclarationError) {
    assert.fail(`app.js collided with a global lexical declaration from crmChangelog.js: ${second.error.message}`);
  }
  // Any OTHER error (missing real DOM/React behavior this bare stub
  // doesn't implement) is expected and fine — this test only cares that
  // the SPECIFIC "already been declared" SyntaxError never occurs.
});

test('crmChangelog.js exposes its data through window.DESETOUR_CHANGELOG (a property write, never a competing top-level declaration)', () => {
  const context = makeBrowserLikeContext();
  vm.runInContext(fs.readFileSync(CRM_CHANGELOG_PATH, 'utf8'), context, { filename: 'crmChangelog.js' });
  assert.ok(context.window.DESETOUR_CHANGELOG, 'window.DESETOUR_CHANGELOG must be set');
  assert.ok(Array.isArray(context.window.DESETOUR_CHANGELOG.entries));
  assert.ok(context.window.DESETOUR_CHANGELOG.entries.length > 0);
  assert.ok(Array.isArray(context.window.DESETOUR_CHANGELOG.categories));
  // The old, now-removed globals must NOT reappear — that would reopen
  // exactly the collision surface this fix closes.
  assert.equal(context.window.CRM_CHANGELOG, undefined);
  assert.equal(context.window.CRM_CHANGELOG_CATEGORIES, undefined);
});

test('crmChangelog.js declares NOTHING at its own top level — every const/let/class is IIFE-scoped, so it can never collide with app.js or any other classic script again', () => {
  const src = fs.readFileSync(CRM_CHANGELOG_PATH, 'utf8');
  // Strip the leading 'use strict' and comments/whitespace, then confirm
  // the very next real statement is the wrapping IIFE, not a bare
  // top-level declaration.
  const body = src
    .replace(/^'use strict';\s*/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();
  assert.match(body, /^\(function\s*\(\)\s*\{/, 'crmChangelog.js must wrap its body in a top-level IIFE');
  assert.match(src.trim(), /\}\)\(\);\s*$/, 'the wrapping IIFE must be immediately invoked and closed at end of file');
});

// ── Meta-test: prove this harness actually catches the bug, not just  ──
// ── that today's code happens to pass it (guards against a vacuous test) ──

test('meta: this vm-based harness DOES catch the exact incident when reproduced with the old (broken) pattern', () => {
  const context = makeBrowserLikeContext();
  const brokenCrmChangelog = `
    const CRM_CHANGELOG_CATEGORIES = ['Yeni Özellik'];
    const CRM_CHANGELOG = [{ version: '1.00' }];
    window.CRM_CHANGELOG = CRM_CHANGELOG;
    window.CRM_CHANGELOG_CATEGORIES = CRM_CHANGELOG_CATEGORIES;
  `;
  const brokenAppJsSnippet = `
    const CRM_CHANGELOG = (window.CRM_CHANGELOG) || [];
    const CRM_CHANGELOG_CATEGORIES = (window.CRM_CHANGELOG_CATEGORIES) || [];
  `;
  const first = runClassicScript(brokenCrmChangelog, 'crmChangelog.js (broken repro)', context);
  assert.equal(first.threw, false);
  const second = runClassicScript(brokenAppJsSnippet, 'app.js (broken repro)', context);
  assert.equal(second.threw, true, 'the broken pattern must reproduce a thrown error');
  assert.equal(second.isDuplicateDeclarationError, true, `expected a duplicate-declaration SyntaxError, got: ${second.error && second.error.message}`);
});

// ── Guard against regressing to the old namespace anywhere in source ───

// Matches the OLD, now-fixed executable expressions specifically
// (`window.CRM_CHANGELOG)` / `window.CRM_CHANGELOG_CATEGORIES)`, as they
// appeared in the buggy `const X = (typeof window !== 'undefined' &&
// window.X) || []` pattern) — never the bare substring, since this
// file's own explanatory comments legitimately mention the old global
// names by name when describing the incident they caused.
const OLD_EXECUTABLE_GLOBAL_READ = /window\.CRM_CHANGELOG\)|window\.CRM_CHANGELOG_CATEGORIES\)|window\.CRM_CHANGELOG\s*=[^=]/;

test('DeseTourDashboard.jsx reads changelog data only via window.DESETOUR_CHANGELOG, never a bare window.CRM_CHANGELOG global', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'DeseTourDashboard.jsx'), 'utf8');
  assert.doesNotMatch(source, OLD_EXECUTABLE_GLOBAL_READ);
  assert.match(source, /window\.DESETOUR_CHANGELOG/);
});

test('the built app.js (generated artifact, not just source) also reflects the fix — no leftover window.CRM_CHANGELOG reference', () => {
  const appJsSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
  assert.doesNotMatch(appJsSrc, OLD_EXECUTABLE_GLOBAL_READ);
  assert.match(appJsSrc, /window\.DESETOUR_CHANGELOG/);
});

test('crmChangelog.js\'s Node-facing export shape (CRM_CHANGELOG, CRM_CHANGELOG_CATEGORIES) is unchanged, so existing tests/dashboard/crmChangelog.test.js needs no changes', () => {
  const { CRM_CHANGELOG, CRM_CHANGELOG_CATEGORIES } = require(CRM_CHANGELOG_PATH);
  assert.ok(Array.isArray(CRM_CHANGELOG) && CRM_CHANGELOG.length > 0);
  assert.ok(Array.isArray(CRM_CHANGELOG_CATEGORIES) && CRM_CHANGELOG_CATEGORIES.length > 0);
});

// A version/entry-count assertion pinned to the exact moment this
// collision hotfix shipped (was: "version must remain 12.36, changelog
// length must remain 9") lived here previously. That was only ever true
// immediately after the hotfix and necessarily goes stale the instant any
// later legitimate release ships (as one now has — see crmChangelog.js's
// newest entry) — it duplicated, less durably, what tests/dashboard/
// crmChangelog.test.js already checks properly (CRM_CHANGELOG[0].version
// === the live crm-version.json, checked dynamically, not hardcoded).
// Removed rather than perpetually re-bumped; the collision fix itself
// remains fully covered by every other test in this file.

test('build.js\'s crmChangelog.js cache-busting (added for the earlier release) is untouched by this hotfix', () => {
  const buildJs = fs.readFileSync(path.join(REPO_ROOT, 'build.js'), 'utf8');
  assert.match(buildJs, /cacheBustScriptTag\(html, 'crmChangelog\.js'/);
});
