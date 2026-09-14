const babel = require('@babel/core');
const crypto = require('crypto');
const fs = require('fs');

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

// Cache-bust app.js in index.html with a content hash so a fixed bundle is
// never masked by a browser/CDN caching the previous deploy's app.js under
// the same unversioned URL.
const hash = crypto.createHash('sha256').update(result.code).digest('hex').slice(0, 10);
const indexPath = './index.html';
const html = fs.readFileSync(indexPath, 'utf8');
const updated = html.replace(/src="app\.js(?:\?v=[a-f0-9]+)?"/, `src="app.js?v=${hash}"`);
if (updated !== html) {
  fs.writeFileSync(indexPath, updated);
  console.log('[build] index.html app.js cache-bust:', hash);
} else {
  console.warn('[build] WARNING: could not find app.js script tag in index.html to cache-bust.');
}
console.log('[build] Done.');
