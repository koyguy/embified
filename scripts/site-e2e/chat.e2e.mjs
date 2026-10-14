// Headless run through the scripted signup chat (site/index.html).
// Usage: npx -y -p playwright@1.46.0 node scripts/site-e2e/chat.e2e.mjs [--shots /workspace]
// (or: npm i --no-save playwright && node scripts/site-e2e/chat.e2e.mjs)
// Serves site/ on a local port, so nothing hits the network except link targets we never open.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site');
const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.sh': 'text/plain' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

async function run(name, viewport, fast) {
  console.log(name);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const q = fast ? '&fast=1' : '';
  await page.goto(`${base}/?ref=friend42${q}`);
  const tap = async (label) => { const b = page.locator('#replies').getByText(label, { exact: false }).first(); await b.waitFor({ timeout: 15000 }); await b.click(); await settle(); };
  const settle = () => page.waitForFunction(() => document.querySelector('#replies').children.length > 0 || !document.querySelector('#inputrow').classList.contains('hidden'), null, { timeout: 20000 });
  const shot = async (n) => { if (shots) await page.waitForTimeout(400); if (shots) await page.screenshot({ path: path.join(shots, `chat-${name}-${n}.png`) }); };

  await tap("Let's go");
  check(await page.locator('#replies').getByText('Home box').count() === 1, 'path choice offers home box');
  await shot('1-path');
  await tap('Oracle free');
  await tap('Not sure'); // branch
  check(/card controls/i.test(await page.locator('#log').innerText()), 'card "not sure" branch answers');
  await tap("Done, it's enabled");
  await tap('Mumbai');
  await page.locator('a.cta[href="https://signup.cloud.oracle.com/"]').first().waitFor();
  check(true, 'signup button links to signup.cloud.oracle.com');
  check(/India West \(Mumbai\)/.test(await page.locator('#log').innerText()), 'chosen region echoed in signup steps');
  await shot('2-signup');
  await tap("I'm stuck");
  await tap('Error processing transaction');
  check(/fraud filter/.test(await page.locator('#log').innerText()), 'stuck → "Error processing transaction" branch');
  await tap('What\'s this charge');
  check(/US\$1/.test(await page.locator('.msg.bot').last().innerText()), 'charge explanation mentions ~US$1');
  // FAQ anytime, then back
  await page.click('#faqbtn'); await settle();
  await tap('Who can see my chats');
  await tap('Back to setup');
  await tap('Got it, back to signup');
  await tap('Done, account ready');
  await tap('Cloud Shell is open');
  const code = page.locator('.code code').last();
  await code.waitFor();
  const cmd = await code.innerText();
  check(/^bash <\(curl -fsSL https:\/\/koyguy\.github\.io\/embified\/install\/oci-launch\.sh\)$/.test(cmd), 'install command is the hosted one-liner');
  await page.locator('.copy').last().click();
  check(/Copied/.test(await page.locator('.copy').last().innerText()), 'copy button reports Copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  check(clip === cmd, 'clipboard holds the command');
  await shot('3-command');
  await tap('It showed an error');
  await tap('No free capacity');
  await tap('I got my vault link');
  await page.fill('#text', 'not a link');
  await page.press('#text', 'Enter');
  await page.waitForTimeout(200);
  check(/doesn't look like a vault link/.test(await page.locator('.msg.bot').last().innerText()), 'invalid vault link rejected');
  // resume check: reload mid-flow keeps transcript + input
  await page.reload();
  check(await page.locator('#inputrow').isVisible(), 'reload resumes at the paste step');
  await page.fill('#text', 'https://soil-inquiry-textbooks-original.trycloudflare.com');
  await page.press('#text', 'Enter');
  await page.locator('a.cta[href="https://soil-inquiry-textbooks-original.trycloudflare.com/"]').waitFor();
  check(true, 'valid link accepted and used for "Open my vault"');
  await shot('4-qr');
  await tap('I scanned it');
  await page.getByText('Vault Keeper unlocked').waitFor();
  const xp = Number(await page.locator('#xp').innerText());
  check(xp === 1050, `XP is 1050 with referral bonus (got ${xp})`);
  const invite = await page.locator('.code code').last().innerText();
  check(/\/\?ref=[A-Za-z0-9]{8}$/.test(invite), 'invite link has own ref code');
  await page.waitForTimeout(fast ? 0 : 1200);
  await shot('5-done');
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

try {
  await run('mobile', { width: 390, height: 844 }, !shots);
  await run('desktop', { width: 1280, height: 860 }, true);
} finally { server.close(); }
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
