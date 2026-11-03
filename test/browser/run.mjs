// Browser test (Playwright): `npm run test:browser`. Uses a globally installed Playwright (see playwright.mjs);
// BROWSERS=chromium,firefox,webkit picks the browsers (default chromium). The plugin's sources, credentials and
// registered files are tested in a browser by smaltdb's own browser test, which installs this plugin.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadPlaywright } from './playwright.mjs';
import { serve } from './serve.mjs';

const playwright = loadPlaywright();
const out = '.cache/browser-test';
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['test/browser/page.ts'], bundle: true, format: 'esm', target: 'es2022', outfile: `${out}/page.js`, logLevel: 'warning' });
writeFileSync(`${out}/index.html`, '<!doctype html><meta charset="utf-8"><title>@smaltdb/external</title><script type="module" src="./page.js"></script>');
const server = await serve({ '/': out });

let failed = false;
for (const name of (process.env.BROWSERS ?? 'chromium').split(',')) {
  const browser = await playwright[name].launch();
  const page = await browser.newPage();
  const log = [];
  page.on('console', (m) => log.push(`console.${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => log.push(`pageerror: ${e.stack ?? e.message}`));
  await page.goto(server.url + '/');
  let result;
  try {
    await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 60_000 });
    result = await page.evaluate(() => window.__result);
  } catch (e) {
    result = { ok: false, error: `no result: ${e.message.split('\n')[0]}` };
  }
  console.log(`\n== ${name} ${browser.version()}`);
  await browser.close();
  if (!result.ok) {
    console.log('FAIL  ' + result.error);
    for (const l of log) console.log('  ' + l);
    failed = true;
    continue;
  }
  for (const c of result.checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail && !c.ok ? `  (${c.detail})` : ''}`);
    if (!c.ok) failed = true;
  }
}
server.close();
process.exit(failed ? 1 : 0);
