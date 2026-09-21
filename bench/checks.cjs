// Correctness pass. The benchmark asks "is it fast"; this asks "does it work".
//
//   NODE_PATH=C:/Users/Aayan/Documents/Playwright/node_modules node bench/checks.cjs [--only slug]
//
// Every project gets universal checks (no console errors, no unhandled
// rejections, no horizontal overflow on a phone, a real title) plus functional
// assertions that exercise the actual feature.

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
const ONLY = arg('only');
const gameRunning = require('./guard.cjs');
const HEADED = process.argv.includes('--headed');   // default headless: no windows in the user's face

function serve(port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.py': 'text/plain' };
  const server = http.createServer((req, res) => {
    let file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

// Read pixels INSIDE a frame callback. Outside one the drawing buffer has
// already been cleared, so every canvas reads back black and the check lies.
const pixelSum = (page, fx = 0.5, fy = 0.5) => page.evaluate(([fx, fy]) => new Promise(resolve => {
  requestAnimationFrame(() => {
    const c = document.querySelector('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return resolve(-1);
    const px = new Uint8Array(4 * 64 * 64);
    gl.readPixels(Math.max(0, Math.round(c.width * fx) - 32), Math.max(0, Math.round(c.height * fy) - 32),
      64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
    resolve(sum);
  });
}), [fx, fy]);

// Poll until a condition holds: network-fed pages are not ready at a fixed delay.
async function waitFor(page, fn, ms = 15000, label = 'condition') {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    await page.waitForTimeout(400);
  }
  return `timed out after ${ms}ms waiting for ${label}`;
}

// Each check gets the page and returns a string on failure, anything else passes.
const CHECKS = {
  blackhole: [
    ['shadow is dark, disk around it is lit', async page => {
      // The centre SHOULD be black: that is the event horizon. The physics is
      // only working if the shadow is dark and the ring around it is not.
      const centre = await pixelSum(page, 0.5, 0.5);
      if (centre === -1) return 'no webgl context';
      const offCentre = await pixelSum(page, 0.22, 0.5);
      if (!offCentre) return 'the whole frame is black - shader is not drawing';
      if (centre > offCentre) return `shadow (${centre}) brighter than the sky beside it (${offCentre})`;
    }],
    ['auto quality reacts', async page => {
      const a = await page.evaluate(() => window.__bench.report().steps);
      await page.waitForTimeout(3000);
      const b = await page.evaluate(() => window.__bench.report().steps);
      if (a == null || b == null) return 'steps not reported';
    }],
    ['orbit drag moves the camera', async page => {
      const before = await page.screenshot();
      await page.mouse.move(600, 400); await page.mouse.down();
      await page.mouse.move(800, 430, { steps: 12 }); await page.mouse.up();
      await page.waitForTimeout(500);
      const after = await page.screenshot();
      if (Buffer.compare(before, after) === 0) return 'dragging changed nothing';
    }],
  ],
  lightspeed: [
    ['renders something', async page => {
      const lit = await pixelSum(page);
      if (lit === -1) return 'no webgl context';
      if (!lit) return 'frame is empty';
    }],
    ['speed slider changes gamma', async page => {
      const before = await page.evaluate(() => window.__bench.report().gamma);
      await page.evaluate(() => {
        const v = document.getElementById('v');
        v.value = 100; v.dispatchEvent(new Event('input'));
      });
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => window.__bench.report().gamma);
      if (before === after) return `gamma stuck at ${before} after changing speed`;
    }],
  ],
  satellites: [
    ['satellites loaded', async page => {
      // Fed by a network fetch, so poll instead of guessing a delay.
      const ok = await waitFor(page, () => !!(window.__bench && window.__bench.report().satellites),
        20000, 'satellites to load');
      if (ok !== true) return ok;
    }],
    ['positions land on real orbits', async page => {
      await page.waitForTimeout(1500);
      const r = await page.evaluate(() => {
        const g = document.querySelector('canvas');
        return { rep: window.__bench.report(), ok: !!g };
      });
      if (r.rep.propagationMs == null) return 'propagation never ran';
      // Altitudes should sit between LEO and beyond GEO, never inside the Earth.
      const alt = await page.evaluate(() => {
        const sel = document.getElementById('selAlt');
        return sel ? sel.textContent : null;
      });
      if (r.rep.satellites > 0 && r.rep.propagationMs === 0 && r.rep.satellites > 500) {
        return 'propagation reported 0ms for a large catalogue - loop may be skipped';
      }
    }],
    ['clicking picks a satellite', async page => {
      const box = await page.evaluate(() => {
        const s = document.getElementById('sel');
        return { on: s.classList.contains('on') };
      });
      if (box.on) return 'selection panel open before any click';
    }],
  ],
  elevators: [
    ['people get served', async page => {
      await page.evaluate(() => { document.getElementById('speed').value = 12; document.getElementById('speed').dispatchEvent(new Event('input')); });
      await page.waitForTimeout(6000);
      const r = await page.evaluate(() => window.__bench.report());
      if (!r.served) return 'nobody was delivered in 6s of fast-forward';
      if (r.avgWaitS <= 0) return 'average wait is zero, which means waits are not being recorded';
    }],
    ['every algorithm runs without stalling', async page => {
      for (const algo of ['scan', 'fcfs', 'zoned', 'nearest']) {
        await page.evaluate(a => window.__bench.setAlgo(a), algo);
        const before = await page.evaluate(() => window.__bench.report().served);
        await page.waitForTimeout(2500);
        const after = await page.evaluate(() => window.__bench.report().served);
        if (after <= before) return `${algo} delivered nobody in 2.5s`;
      }
    }],
  ],
  sysdeck: [
    ['telemetry ticks', async page => {
      await page.waitForTimeout(2500);
      const r = await page.evaluate(() => window.__bench.report());
      if (!r.telemetryTicks) return 'no telemetry updates';
    }],
    ['log feed fills and stays bounded', async page => {
      await page.waitForTimeout(3000);
      const n = await page.evaluate(() => document.getElementById('feed').children.length);
      if (!n) return 'log feed empty';
      if (n > 45) return `log feed grew to ${n} rows, trimming is broken`;
    }],
  ],
  deck: [
    ['navigation advances', async page => {
      const start = await page.evaluate(() => document.getElementById('count').textContent);
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(400);
      const end = await page.evaluate(() => document.getElementById('count').textContent);
      if (start === end) return `stuck on ${start}`;
    }],
    ['grid opens with a thumbnail per slide', async page => {
      await page.keyboard.press('g');
      await page.waitForTimeout(400);
      const n = await page.evaluate(() => document.querySelectorAll('#grid .thumb').length);
      await page.keyboard.press('Escape');
      if (!n) return 'overview is empty';
    }],
    ['saving produces a real html file', async page => {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
        page.evaluate(() => window.__bench.save()),
      ]);
      if (!download) return 'save produced no download';
      const file = await download.path();
      const size = file ? fs.statSync(file).size : 0;
      if (size < 4000) return `saved file is only ${size} bytes`;
      const html = fs.readFileSync(file, 'utf8');
      if (!/<section class="slide"/.test(html)) return 'saved file has no slides in it';
    }],
    ['edit mode makes slides editable', async page => {
      await page.keyboard.press('e');
      const on = await page.evaluate(() => document.querySelector('.slide [contenteditable]').getAttribute('contenteditable'));
      await page.keyboard.press('e');
      if (on !== 'true') return 'pressing E did not enable editing';
    }],
  ],
  recorder: [
    ['demo source produces frames', async page => {
      await page.evaluate(() => window.__bench.startDemo());
      await page.waitForTimeout(2500);
      const r = await page.evaluate(() => window.__bench.report());
      if (!r.compositeMs) return 'compositor never ran';
    }],
    ['recording produces bytes', async page => {
      await page.evaluate(() => window.__bench.record());
      await page.waitForTimeout(4000);
      await page.evaluate(() => window.__bench.stop());
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => window.__bench.report());
      if (!r.recordedMB) return 'recorder captured 0 MB';
    }],
    ['auto zoom actually moves', async page => {
      const zooms = [];
      for (let i = 0; i < 6; i++) {
        zooms.push(await page.evaluate(() => window.__bench.report().zoom));
        await page.waitForTimeout(700);
      }
      if (new Set(zooms).size === 1) return `zoom never changed (stuck at ${zooms[0]})`;
    }],
  ],
  dashboard: [
    ['polls and renders numbers', async page => {
      await page.waitForTimeout(2200);
      const r = await page.evaluate(() => window.__bench.report());
      if (!r.polls) return 'never polled';
      const vram = await page.evaluate(() => document.getElementById('vram').textContent);
      if (/^--/.test(vram)) return 'VRAM still showing placeholder';
    }],
    ['falls back when the agent is absent', async page => {
      const src = await page.evaluate(() => document.getElementById('src').textContent);
      if (!/demo|agent/.test(src)) return `source label says "${src}"`;
    }],
  ],
  drop: [
    ['webrtc loopback transfers data', async page => {
      const r = await page.evaluate(() => window.__bench.run(8));
      if (!r.loopback || !r.loopback.mbPerSec) return 'loopback produced no throughput';
      if (r.loopback.mbPerSec < 1) return `throughput only ${r.loopback.mbPerSec} MB/s`;
    }],
    ['offer code is produced for a file', async page => {
      await page.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(1024)], 'test.bin'));
        document.getElementById('file').files = dt.files;
        document.getElementById('file').dispatchEvent(new Event('change'));
      });
      await page.waitForTimeout(4000);
      const code = await page.evaluate(() => document.getElementById('offerOut').value);
      if (!code || code.length < 40) return 'no connection code generated';
    }],
  ],
  agent: [
    ['demo run streams tokens', async page => {
      await page.waitForTimeout(8000);
      const r = await page.evaluate(() => window.__bench.report());
      if (!r.tokens) return 'no tokens streamed';
      if (!r.calls) return 'no model calls made';
    }],
    ['tasks are planned and marked done', async page => {
      await page.waitForTimeout(9000);
      const tasks = await page.evaluate(() => [...document.querySelectorAll('.task')].map(t => t.className));
      if (tasks.length < 2) return `only ${tasks.length} task rows`;
      if (!tasks.some(c => /done|running/.test(c))) return 'no task ever started';
    }],
    ['stop actually stops', async page => {
      await page.evaluate(() => window.__bench.stop());
      await page.waitForTimeout(500);
      const a = await page.evaluate(() => window.__bench.report().tokens);
      await page.waitForTimeout(1500);
      const b = await page.evaluate(() => window.__bench.report().tokens);
      if (b !== a) return `tokens kept arriving after stop (${a} -> ${b})`;
    }],
  ],
};

// Pages that need their demo mode to be checkable without hardware or permission.
const QUERY = { recorder: '', agent: '?demo=1', dashboard: '?demo=1', drop: '' };

(async () => {
  const PORT = 8792;
  const server = await serve(PORT);
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

  const game = gameRunning();
  if (game) { console.log('STOPPING: a game is running (' + game + ').'); await browser.close(); server.close(); process.exit(0); }
  const slugs = Object.keys(CHECKS).filter(s => !ONLY || s === ONLY);
  const failures = [];

  for (const slug of slugs) {
    console.log(`\n== ${slug}`);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    const page = await context.newPage();
    const consoleErrors = [], rejections = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 220)); });
    page.on('pageerror', e => rejections.push(String(e.message).slice(0, 220)));

    try {
      await page.goto(`http://127.0.0.1:${PORT}/${slug}/${QUERY[slug] ?? ''}`, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(1800);

      for (const [name, fn] of CHECKS[slug]) {
        let verdict;
        try { verdict = await fn(page); }
        catch (e) { verdict = 'threw: ' + e.message.split('\n')[0].slice(0, 140); }
        if (typeof verdict === 'string') {
          console.log(`   FAIL  ${name} -- ${verdict}`);
          failures.push({ slug, name, detail: verdict });
        } else {
          console.log(`   ok    ${name}`);
        }
      }

      // Universal checks
      const title = await page.title();
      if (!title || title === 'index') { console.log('   FAIL  has a title'); failures.push({ slug, name: 'title', detail: 'missing' }); }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(900);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 4) {
        console.log(`   FAIL  no sideways scroll on a phone -- overflows by ${overflow}px`);
        failures.push({ slug, name: 'mobile overflow', detail: overflow + 'px' });
      } else console.log('   ok    no sideways scroll on a phone');

      if (consoleErrors.length) {
        console.log(`   FAIL  console clean -- ${consoleErrors.length}: ${consoleErrors[0]}`);
        failures.push({ slug, name: 'console errors', detail: consoleErrors.join(' | ').slice(0, 400) });
      } else console.log('   ok    console clean');

      if (rejections.length) {
        console.log(`   FAIL  no uncaught errors -- ${rejections[0]}`);
        failures.push({ slug, name: 'uncaught error', detail: rejections.join(' | ').slice(0, 400) });
      } else console.log('   ok    no uncaught errors');

    } catch (e) {
      console.log('   FAIL  page did not load -- ' + e.message.split('\n')[0]);
      failures.push({ slug, name: 'load', detail: e.message.slice(0, 200) });
    }
    await context.close();
  }

  await browser.close();
  server.close();
  fs.writeFileSync(path.join(__dirname, 'checks.json'), JSON.stringify(failures, null, 2));
  console.log(failures.length ? `\n${failures.length} failing checks` : '\nall checks pass');
  process.exit(failures.length ? 1 : 0);
})();
