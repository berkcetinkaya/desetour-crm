const babel = require('@babel/core');
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
console.log('[build] Done.');
