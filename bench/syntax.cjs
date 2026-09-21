// Extract every inline <script> from each project and syntax-check it.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const projects = JSON.parse(fs.readFileSync(path.join(__dirname, 'projects.json'), 'utf8'));
let bad = 0;
for (const p of projects) {
  const file = path.join(ROOT, p.slug, 'index.html');
  if (!fs.existsSync(file)) { console.log('MISSING', p.slug); bad++; continue; }
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m, n = 0, errs = [];
  while ((m = re.exec(html))) {
    const attrs = m[1] || '', code = m[2];
    if (/src=/.test(attrs) || /x-shader|importmap/.test(attrs)) continue;
    n++;
    const isModule = /type\s*=\s*["']module["']/.test(attrs);
    try {
      if (isModule) new vm.SourceTextModule(code);
      else new vm.Script(code);
    } catch (e) {
      errs.push(`  script ${n}: ${e.message.split('\n')[0]}`);
    }
  }
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  if (errs.length) { bad++; console.log(`FAIL ${p.slug} (${kb} KB)\n${errs.join('\n')}`); }
  else console.log(`ok   ${p.slug.padEnd(11)} ${String(n).padStart(2)} scripts  ${kb.padStart(4)} KB`);
}
console.log(bad ? `\n${bad} project(s) with problems` : '\nall projects parse');
process.exit(bad ? 1 : 0);
