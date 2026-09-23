const babel = require('@babel/core');
const crypto = require('crypto');
const fs = require('fs');
const { buildVersionMetadata } = require('./build-version');

const code = fs.readFileSync('./DeseTourDashboard.jsx', 'utf8');
console.log('[build] Input:', Math.round(code.length/1024) + 'KB');

const result = babel.transformSync(code, {
  presets: [
    // Only transform JSX → React.createElement
    // Do NOT transform modern JS (const, arrow fn, etc.)
    // This prevents Babel from mishandling complex JSX patterns
    ['@babel/preset-react', { runtime: 'classic' }],
  ],
  // compact: false keeps whitespace → easier to debug
  // comments: true keeps comments → prevents stripping bugs
  compact: true,
  comments: true,       // ← was false, caused component loss
  retainLines: false,
  filename: 'DeseTourDashboard.jsx',
  sourceType: 'script', // not module — no import/export expected
});

fs.writeFileSync('./app.js', result.code);
console.log('[build] Output: app.js', Math.round(result.code.length/1024) + 'KB');

// Application version + build metadata — generated fresh on every build,
// never hand-edited, never random, never Date.now()-as-a-version. See
// build-version.js for exactly how the version number and timestamp are
// derived. Written as its own small generated file (window.__DESETOUR_BUILD__
// = {...}), loaded before app.js, rather than hand-editing app.js itself —
// app.js stays purely "DeseTourDashboard.jsx, Babel-transformed", nothing else.
const versionMeta = buildVersionMetadata();
const buildMetaCode = `window.__DESETOUR_BUILD__ = ${JSON.stringify(versionMeta)};\n`;
fs.writeFileSync('./build-meta.js', buildMetaCode);
console.log('[build] Version:', versionMeta.version, '| commit', versionMeta.commitShaShort || '(none)', '| branch', versionMeta.branch || '(none)');

// Cache-bust a generated script's src in index.html with a content hash so
// a fixed file is never masked by a browser/CDN caching the previous
// deploy's copy under the same unversioned URL.
function cacheBustScriptTag(html, filename, content) {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
  const re = new RegExp(`src="${filename.replace(/\./g, '\\.')}(?:\\?v=[a-f0-9]+)?"`);
  const updated = html.replace(re, `src="${filename}?v=${hash}"`);
  if (updated === html) {
    console.warn(`[build] WARNING: could not find ${filename} script tag in index.html to cache-bust.`);
    return html;
  }
  console.log(`[build] index.html ${filename} cache-bust:`, hash);
  return updated;
}

const indexPath = './index.html';
let html = fs.readFileSync(indexPath, 'utf8');
html = cacheBustScriptTag(html, 'app.js', result.code);
html = cacheBustScriptTag(html, 'build-meta.js', buildMetaCode);
fs.writeFileSync(indexPath, html);
console.log('[build] Done.');
