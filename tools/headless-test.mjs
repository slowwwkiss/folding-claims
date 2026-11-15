// Headless end-to-end check of the FoldClaim app (docs/) in Chromium.
// Serves docs/ on http://127.0.0.1:8123 first (python3 -m http.server),
// oracle must be running on http://localhost:8787.
// Flow: load -> lookup donor "satoshi" -> request claim -> submit claim
// on-chain -> verify via /api/tx. Screenshots + video into demo/.
// Run: node tools/headless-test.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('/home/hatch/workspace/makefun/bch-blaze/tools/package.json');
const { chromium } = require('playwright-core');

const BASE = process.env.FOLDCLAIM_URL || 'http://127.0.0.1:8123/';
const SHELL = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const DEMO = new URL('../demo/', import.meta.url).pathname;
fs.mkdirSync(DEMO, { recursive: true });

const browser = await chromium.launch({ executablePath: SHELL, args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  recordVideo: { dir: DEMO, size: { width: 1280, height: 900 } },
});
const page = await context.newPage();
const errors = [];
const failedReqs = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('[console.error] ' + m.text()); });
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
page.on('requestfailed', (r) => failedReqs.push(r.url() + ' :: ' + (r.failure()?.errorText || '')));
page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.url() + ' :: HTTP ' + r.status()); });

const txt = async (sel) => (await page.textContent(sel).catch(() => ''))?.trim() || '';
const shot = async (name) => { await page.screenshot({ path: DEMO + name, fullPage: true }); console.log('shot:', name); };

console.log('== load home ==');
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('title:', await page.title());
console.log('oracle status:', await txt('#oracle-status'));
console.log('claim addr:', await txt('#claim-addr'));
console.log('claim tokenaddr:', await txt('#claim-tokenaddr'));
await shot('01-home.png');

console.log('== step 1: lookup satoshi ==');
await page.fill('#in-username', 'satoshi');
await page.click('#btn-lookup');
await page.waitForFunction(
  () => document.querySelector('#fah-result')?.textContent.includes('Reward for this score'),
  { timeout: 60000 },
);
console.log('fah result:', (await txt('#fah-result')).replace(/\s+/g, ' ').slice(0, 400));
console.log('btn-claim disabled:', await page.isDisabled('#btn-claim'));
await shot('02-lookup.png');

console.log('== step 3: request claim ==');
await page.click('#btn-claim');
await page.waitForFunction(
  () => document.querySelector('#claim-result')?.textContent.includes('Escrow tx'),
  { timeout: 180000 },
);
console.log('claim result:', (await txt('#claim-result')).replace(/\s+/g, ' ').slice(0, 500));
console.log('btn-submit disabled:', await page.isDisabled('#btn-submit'));
await shot('03-claim.png');

console.log('== step 4: submit claim on-chain ==');
await page.click('#btn-submit');
await page.waitForFunction(
  () => document.querySelector('#submit-result')?.textContent.includes('Claim tx'),
  { timeout: 180000 },
);
console.log('submit result:', (await txt('#submit-result')).replace(/\s+/g, ' ').slice(0, 500));
await shot('04-submit.png');

console.log('== verify on-chain ==');
await page.click('#btn-verify');
await page.waitForFunction(
  () => document.querySelector('#verify-out')?.textContent.includes('Confirmations'),
  { timeout: 60000 },
);
console.log('verify out:', (await txt('#verify-out')).replace(/\s+/g, ' ').slice(0, 500));
console.log('history total:', await txt('#hist-total'));
console.log('history list:', (await txt('#hist-list')).replace(/\s+/g, ' ').slice(0, 400));
await shot('05-verify.png');

console.log('\n== CONSOLE ERRORS (' + errors.length + ') ==');
errors.forEach((e) => console.log(e));
console.log('== FAILED REQUESTS (' + failedReqs.length + ') ==');
failedReqs.forEach((e) => console.log(e));

const videoPath = await page.video()?.path().catch(() => null);
await context.close();
await browser.close();
console.log('video:', videoPath || '(none)');
console.log('DONE');
