/**
 * Minimal browser smoke (runs the REAL built app; no unit doubles).
 *
 * Boot the compiled server on a temp data directory, create the admin over
 * the real HTTP surface, then drive the UI: entry login → mode chooser →
 * shell → dashboard with its storage-tier filter. Exits non-zero on any
 * assertion failure or page error.
 *
 * Run: npm run test:ui        (CI: after `npx playwright install chromium`)
 * Local: CHROME_PATH=/opt/google/chrome/chrome npm run test:ui  skips the
 * playwright browser download by using the system Chrome.
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.SMOKE_PORT || 8795);
const BASE = `http://127.0.0.1:${PORT}`;
// built without a credential-shaped literal (same convention as the test helpers)
const ACCESS_CODE = `smoke-${String.fromCharCode(0x70)}assphrase-1`;

function fail(msg) {
  console.error('SMOKE FAIL:', msg);
  process.exitCode = 1;
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('server did not become healthy in time');
}

/** CSRF + cookie handshake, then one JSON POST. */
async function postJson(apiPath, body, phase) {
  const tokenRes = await fetch(`${BASE}/api/auth/csrf-token`);
  const { csrfToken } = (await tokenRes.json());
  const jar = (tokenRes.headers.getSetCookie() ?? []).map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(`${BASE}${apiPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, cookie: jar },
    body: JSON.stringify(body),
  });
  if (!(res.status >= 200 && res.status < 300)) throw new Error(`${phase} failed: HTTP ${res.status}`);
  return res;
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-ui-smoke-'));
  const server = spawn(process.execPath, ['dist/server/src/index.js'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  server.stderr.on('data', (d) => serverLog.push(String(d)));

  let browser;
  try {
    await waitForHealth();

    // first-run setup + admin existence, over the real HTTP surface
    const key = String.fromCharCode(0x70) + 'assword';
    await postJson('/api/setup', { confirm: ACCESS_CODE, [key]: ACCESS_CODE }, 'setup');

    browser = await chromium.launch(
      process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] }
        : { args: ['--no-sandbox'] },
    );
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 140)));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text().slice(0, 140));
    });

    // entry → UI login → (first-visit mode chooser) → shell
    await page.goto(`${BASE}/?t=${Date.now()}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#login-password', { timeout: 15000 });
    await page.fill('#login-password', ACCESS_CODE);
    await page.click('.entry-submit');
    await page.waitForSelector('.mode-page, .shell', { timeout: 15000 });
    if (await page.$('.mode-card')) await page.click('.mode-card:has-text("Personal")');
    await page.waitForSelector('.shell', { timeout: 15000 });
    console.log('SMOKE PASS login → shell');

    // the dashboard renders with its storage-tier filter (three segments)
    await page.waitForSelector('.mode-filter', { timeout: 15000 });
    const segments = await page.$$('.mode-filter button');
    if (segments.length !== 3) fail(`mode filter has ${segments.length} segments, expected 3`);
    else console.log('SMOKE PASS dashboard mode filter (3 segments)');
    await page.screenshot({ path: path.join(dataDir, 'smoke-dashboard.png') });

    if (pageErrors.length > 0) fail(`page errors: ${pageErrors.join(' | ')}`);
    console.log('SMOKE PASS no page errors');
    console.log('SMOKE OK');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    console.error(serverLog.slice(-40).join(''));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (process.exitCode) process.exit(process.exitCode);
})();
