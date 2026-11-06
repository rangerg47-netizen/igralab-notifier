'use strict';
// Мини-загрузчик файла .env (KEY=VALUE построчно). Уже заданные переменные не перезаписываются.
const fs = require('fs');
const path = require('path');
function load(file) {
  const f = path.resolve(file || '.env');
  if (!fs.existsSync(f)) return;
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}
module.exports = { load };
