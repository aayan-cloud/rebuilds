// Peak + real-life benchmark for the rebuilds.
//
//   NODE_PATH=C:/Users/Aayan/Documents/Playwright/node_modules \
//   node bench/bench.cjs [--only blackhole,elevators] [--headed] [--seconds 20]
//
// Every project exposes window.__bench.report(). This drives each one through
// four scenarios, records frame timings, heap, console errors and a screenshot,
// then writes bench/results.json and bench/RESULTS.md.
//
// GPU note: headless still uses the real GPU here (ANGLE + D3D11, verified:
// renderer reports the RTX 5060 Ti). Pass --headed only to watch it work.

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const gameRunning = require('./guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = __dirname;
const SHOTS = path.join(OUT, 'shots');

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? (process.argv[i + 1] ?? true) : fallback;
};
const SECONDS = +arg('seconds', 20);
const HEADED = process.argv.includes('--headed');   // default headless: no windows in the user's face
const ONLY = arg('only', null);

const PROJECTS = JSON.parse(fs.readFileSync(path.join(OUT, 'projects.json'), 'utf8'))
  .filter(p => !ONLY || String(ONLY).split(',').includes(p.slug));

// Real hardware, real conditions. Mobile mirrors a mid-range Android: small
// viewport, 4x slower CPU, touch.
const SCENARIOS = [
  { id: 'desktop-real', label: 'Desktop, real life', viewport: { width: 1920, height: 1080 },
    dpr: 1, cpu: 1, peak: false, seconds: SECONDS },
  { id: 'mobile-real', label: 'Mid-range phone, real life', viewport: { width: 390, height: 844 },
    dpr: 3, cpu: 4, peak: false, seconds: SECONDS, mobile: true },
  { id: 'desktop-peak', label: 'Desktop, peak load', viewport: { width: 1920, height: 1080 },
    dpr: 1, cpu: 1, peak: true, seconds: Math.round(SECONDS * 1.5) },
  { id: 'mobile-peak', label: 'Phone, peak load', viewport: { width: 390, height: 844 },
    dpr: 3, cpu: 4, peak: true, seconds: SECONDS, mobile: true },
];

// ---------------------------------------------------------------- static host
function serve(port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.webp': 'image/webp', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(ROOT, clean);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// ------------------------------------------------------------------ one run
async function runScenario(browser, project, scenario, base) {
  const context = await browser.newContext({
    viewport: scenario.viewport,
    deviceScaleFactor: scenario.dpr,
    isMobile: !!scenario.mobile,
    hasTouch: !!scenario.mobile,
    userAgent: scenario.mobile
      ? 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
      : undefined,
  });
  const page = await context.newPage();

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push('pageerror: ' + String(e.message).slice(0, 200)));

  const cdp = await context.newCDPSession(page);
  if (scenario.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: scenario.cpu });

  const url = base + '/' + project.slug + '/' + (scenario.peak ? '?peak=1' : '');
  const t0 = Date.now();
  let loadMs = null, failed = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    loadMs = Date.now() - t0;
  } catch (e) {
    failed = 'load failed: ' + e.message.slice(0, 160);
  }

  let report = null, interactive = null;
  if (!failed) {
    // Let it settle, then measure only the steady state.
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.__bench && window.__bench.reset && window.__bench.reset()).catch(() => {});

    if (project.interact) {
      // Wrap in parens and call it: a bare arrow string only creates the
      // function, it never runs, so the interaction silently did nothing.
      try { await page.evaluate(`(${project.interact})()`); interactive = true; }
      catch (e) { interactive = 'interaction failed: ' + e.message.slice(0, 120); }
    }

    await page.waitForTimeout(scenario.seconds * 1000);
    report = await page.evaluate(() => {
      if (!window.__bench || !window.__bench.report) return null;
      try { return window.__bench.report(); } catch (e) { return { error: String(e) }; }
    }).catch(e => ({ error: String(e).slice(0, 160) }));

    const paint = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return {
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        firstPaintMs: fcp ? Math.round(fcp.startTime) : null,
        transferKB: nav ? Math.round((nav.transferSize || 0) / 1024) : null,
      };
    }).catch(() => ({}));
    Object.assign(report || (report = {}), paint);

    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, `${project.slug}-${scenario.id}.png`) }).catch(() => {});
  }

  await context.close();
  return { scenario: scenario.id, label: scenario.label, loadMs, failed, errors: errors.slice(0, 5), interactive, ...(report || {}) };
}

// Cold load on a throttled connection: does it open at all on bad internet?
async function coldLoad(browser, project, base) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 400, downloadThroughput: 400 * 1024 / 8, uploadThroughput: 400 * 1024 / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t0 = Date.now();
  let ms = null, err = null;
  try {
    await page.goto(base + '/' + project.slug + '/', { waitUntil: 'load', timeout: 60000 });
    ms = Date.now() - t0;
  } catch (e) { err = e.message.slice(0, 120); }
  await context.close();
  return { slow3gLoadMs: ms, slow3gError: err };
}

// ---------------------------------------------------------------------- main
(async () => {
  const PORT = 8791;
  const server = await serve(PORT);
  const base = `http://127.0.0.1:${PORT}`;
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11',
           // uncap the frame rate: otherwise every healthy page reads exactly
           // 60 (headless) or 199 (this monitor) and real headroom is hidden
           '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  });

  const results = [];
  for (const project of PROJECTS) {
    process.stdout.write(`\n== ${project.name} (${project.slug})\n`);
    const runs = [];
    for (const scenario of SCENARIOS) {
      const game = gameRunning();
      if (game) {
        console.log(`\n\nSTOPPING: a game is running (${game}). The GPU belongs to it.`);
        await browser.close();
        server.close();
        fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ seconds: SECONDS, partial: true, stoppedFor: game, results }, null, 2));
        process.exit(0);
      }
      process.stdout.write(`   ${scenario.label.padEnd(28)}`);
      const r = await runScenario(browser, project, scenario, base);
      runs.push(r);
      if (r.failed) process.stdout.write(`FAILED  ${r.failed}\n`);
      else process.stdout.write(
        `${String(r.fps ?? '--').padStart(5)} fps  p95 ${String(r.p95FrameMs ?? '--').padStart(6)} ms` +
        `  heap ${String(r.memoryMB ?? '--').padStart(4)} MB  ${r.errors.length ? r.errors.length + ' console errors' : 'clean'}\n`);
    }
    const cold = await coldLoad(browser, project, base);
    process.stdout.write(`   slow 3G cold load           ${cold.slow3gLoadMs ?? 'FAILED'} ms\n`);
    results.push({ ...project, cold, runs });
  }

  await browser.close();
  server.close();

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ seconds: SECONDS, results }, null, 2));
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), markdown(results));
  console.log('\nwrote bench/results.json and bench/RESULTS.md');
})();

function markdown(results) {
  const verdict = runs => {
    const bad = runs.filter(r => r.failed || (r.fps != null && r.fps < 24) || r.errors.length);
    if (runs.some(r => r.failed)) return 'BROKEN';
    if (bad.length) return 'needs work';
    // Pages without a frame loop (Toss, Machine) report no fps; judge those on
    // whether they ran clean, not on a zero that was never measured.
    const rates = runs.map(r => r.fps).filter(v => v != null);
    if (!rates.length) return 'ships';
    const worst = Math.min(...rates);
    return worst >= 50 ? 'ships' : worst >= 30 ? 'ok' : 'needs work';
  };
  let md = '# Rebuild benchmark results\n\n';
  md += 'Measured on Aayan\'s RTX 5060 Ti, real GPU (headed Chromium). Mobile rows are a 390x844 viewport at 4x CPU throttle.\n\n';
  md += '| Project | Scenario | fps | p95 frame | worst frame | dropped | heap | load | notes |\n';
  md += '|---|---|---|---|---|---|---|---|---|\n';
  for (const p of results) {
    for (const r of p.runs) {
      const notes = r.failed ? r.failed : (r.errors.length ? r.errors.length + ' console errors' : '');
      md += `| ${p.name} | ${r.label} | ${r.fps ?? '--'} | ${r.p95FrameMs ?? '--'} ms | ${r.worstFrameMs ?? '--'} ms | `
          + `${r.slowFrames ?? '--'} | ${r.memoryMB ?? '--'} MB | ${r.loadMs ?? '--'} ms | ${notes} |\n`;
    }
  }
  md += '\n## Verdict\n\n';
  for (const p of results) {
    md += `- **${p.name}** — ${verdict(p.runs)}; slow-3G cold load ${p.cold.slow3gLoadMs ?? 'failed'} ms\n`;
  }
  return md;
}
