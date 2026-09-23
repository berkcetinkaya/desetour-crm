'use strict';
/**
 * DeseTourDashboard.jsx is a single, module-less browser script (Babel
 * transforms JSX -> JS with sourceType:'script', loaded via a plain
 * <script> tag — see build.js). It cannot be require()'d directly: it
 * references browser-only globals (window, document, React, the Supabase
 * client, ...) at module scope, so loading the whole 900KB+ file in Node
 * would either throw or attempt to mount a real UI.
 *
 * Functions meant to be unit-tested in isolation are wrapped in
 * `// TESTABLE:<name>:start` / `// TESTABLE:<name>:end` marker comments
 * directly in the source. This helper extracts exactly the text between
 * those markers and evaluates it, so tests exercise the REAL, currently
 * shipping implementation — never a hand-copied duplicate that could
 * silently drift from it.
 */
const fs = require('fs');
const path = require('path');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'DeseTourDashboard.jsx');

function extractTestableFn(name) {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const startMarker = `// TESTABLE:${name}:start`;
  const endMarker = `// TESTABLE:${name}:end`;
  const startIdx = source.indexOf(startMarker);
  const endIdx = source.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`extractTestableFn: markers for "${name}" not found in DeseTourDashboard.jsx`);
  }
  const body = source.slice(startIdx + startMarker.length, endIdx);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${body}\nreturn ${name};`);
  return factory();
}

module.exports = { extractTestableFn };
