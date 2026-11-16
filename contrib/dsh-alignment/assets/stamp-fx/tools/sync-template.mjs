// Inline stamp-fx.js into the alignment page template, between the @stamp-fx-begin / @stamp-fx-end markers.
// usage: node contrib/dsh-alignment/assets/stamp-fx/tools/sync-template.mjs   (from the repo root)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(fileURLToPath(new URL('../stamp-fx.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n').trimEnd();
const tplPath = fileURLToPath(new URL('../../../cli/template.html', import.meta.url));
const tpl = fs.readFileSync(tplPath, 'utf8');
const BEGIN = '// @stamp-fx-begin（盖章动效，原样内联自 assets/stamp-fx/stamp-fx.js，改它后跑 assets/stamp-fx/tools/sync-template.mjs）\n';
const END = '// @stamp-fx-end\n';
const a = tpl.indexOf('// @stamp-fx-begin'), b = tpl.indexOf(END);
if (a < 0 || b < a) throw new Error('template.html: @stamp-fx-begin / @stamp-fx-end markers not found');
const next = tpl.slice(0, a) + BEGIN + src + '\n' + tpl.slice(b);
fs.writeFileSync(tplPath, next);
console.log('synced', src.length, 'chars into', tplPath);
