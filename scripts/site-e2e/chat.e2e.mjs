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
  const shot = async (n) => { if (!shots || name !== 'mobile') return; await page.waitForTimeout(600); await page.screenshot({ path: path.join(shots, `chat2-${n}.png`) }); };
  const pct = () => page.evaluate(() => window.__embifiedChat.pct());
  const status = () => page.locator('#vstatus').innerText();

  await settle();
  check(/About 30 minutes\. At the end you'll have your own private archive/.test(await page.locator('#log').innerText()), 'start makes the 30-minute promise');
  check(/only keeps your group history/.test(await page.locator('#log').innerText()), 'start states the phone-only stakes');
  check(await page.locator('#xp').count() === 0 && !/XP/.test(await page.content()), 'no XP anywhere on the page');
  check(await page.locator('#stages li').count() === 6, 'vault has six stages');
  check(/0% built · about 30 minutes left/.test(await status()), 'status starts at 0% / ~30 min');
  await shot('start');
  await tap("Let's build my vault");
  check(await page.locator('#replies').getByText('Home box').count() === 1, 'path choice offers home box');
  await tap('Oracle free');
  await tap('Not sure'); // branch
  check(/card controls/i.test(await page.locator('#log').innerText()), 'card "not sure" branch answers');
  await tap("Done, it's enabled");
  await tap('Mumbai');
  await page.locator('a.cta[href="https://signup.cloud.oracle.com/"]').first().waitFor();
  check(true, 'signup button links to signup.cloud.oracle.com');
  check(/India West \(Mumbai\)/.test(await page.locator('#log').innerText()), 'chosen region echoed in signup steps');
  await tap("I'm at the card step");
  check(await pct() === 15, `claiming space → 15% (got ${await pct()})`);
  check(/Oracle places a <b>~US\$1|~US\$1 check/.test(await page.locator('#log').innerText()), 'card step reassures about ~US$1');
  await page.evaluate(() => window.__embifiedChat.nudge());
  check(/Always Free never charges/.test(await page.locator('.msg.bot').last().innerText()), 'hesitation nudge at card step');
  await shot('card');
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
  await tap('Card verified, account ready');
  check(/Your 150 GB is reserved for you/.test(await page.locator('#log').innerText()), 'lock celebration names what they unlocked');
  await tap('Cloud Shell is open');
  check(await pct() === 40 && /40% built/.test(await status()), 'keys → "Your vault is 40% built"');
  const code = page.locator('.code code').last();
  await code.waitFor();
  const cmd = await code.innerText();
  check(/^bash <\(curl -fsSL https:\/\/koyguy\.github\.io\/embified\/install\/oci-launch\.sh\)$/.test(cmd), 'install command is the hosted one-liner');
  await page.locator('.copy').last().click();
  check(/Copied/.test(await page.locator('.copy').last().innerText()), 'copy button reports Copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  check(clip === cmd, 'clipboard holds the command');
  await tap('It showed an error');
  await tap('No free capacity');
  await tap('I got my vault link');
  await page.fill('#text', 'not a link');
  await page.press('#text', 'Enter');
  await page.waitForTimeout(200);
  check(/doesn't look like a vault link/.test(await page.locator('.msg.bot').last().innerText()), 'invalid vault link rejected');
  // resume check: reload mid-flow keeps transcript + input
  check(await pct() === 70, `build → 70% (got ${await pct()})`);
  await page.reload();
  check(await page.locator('#inputrow').isVisible(), 'reload resumes at the paste step');
  check(/Welcome back — your vault is 70% built, next step: paste your vault link/.test(await page.locator('.msg.sys').last().innerText()), 'resume message names % and next step');
  await shot('mid');
  await page.fill('#text', 'https://soil-inquiry-textbooks-original.trycloudflare.com');
  await page.press('#text', 'Enter');
  await page.locator('a.cta[href="https://soil-inquiry-textbooks-original.trycloudflare.com/"]').waitFor();
  check(true, 'valid link accepted and used for "Open my vault"');
  await tap('I scanned it');
  await page.locator('.vcard').waitFor();
  check(await pct() === 100 && /built and protected/.test(await status()), 'finish → 100% protected');
  const card = await page.locator('.vcard').innerText();
  check(/soil-inquiry-textbooks-original\.trycloudflare\.com/.test(card) && /150 GB/.test(card) && /India West \(Mumbai\)/.test(card) && /Connected/.test(card) && /Archive started\s*\d{1,2} \w{3} \d{4}/.test(card), 'summary card: link, storage, region, WhatsApp, start date');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.vcard .savecard[data-act="png"]').click()]);
  check(dl.suggestedFilename() === 'my-embified-vault.png', 'save card downloads a PNG');
  const invite = await page.locator('.code code').last().innerText();
  check(/\/\?ref=[A-Za-z0-9]{8}$/.test(invite), 'invite link has own ref code');
  const wa = await page.locator('#replies a').first().getAttribute('href');
  check(/Give a friend their own free vault/.test(await page.locator('#log').innerText()) && /wa\.me/.test(wa) && decodeURIComponent(wa).includes("lose or switch phones") && !/XP/.test(decodeURIComponent(wa)), 'referral framed as a friend\'s free vault, benefit-led WhatsApp text');
  await page.waitForTimeout(fast ? 0 : 1500);
  await page.locator('.vcard').scrollIntoViewIfNeeded();
  await shot('finish');
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
}

async function migration() {
  console.log('migration');
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto(`${base}/?fast=1`);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('embified.chat.v1', JSON.stringify({ log: [{ who: 'bot', html: 'Hi' }, { who: 'sys', html: '🌱 +200 XP · Cloud Citizen badge' }], node: 'command', earned: { path: true, card: true, region: true, signup: true, shell: true }, region: 'ap-hyderabad-1', myRef: 'abcDEF23' })); });
  await page.reload();
  const t = await page.locator('#log').innerText();
  check(!/XP/.test(t), 'old XP bubbles dropped');
  check(/Welcome back — your vault is 40% built, next step: Cloud Shell/.test(t), 'v1 progress migrated to 40% with next step');
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('embified.chat.v2')));
  check(st && st.myRef === 'abcDEF23' && st.built.keys && !st.earned, 'v2 state keeps ref code, maps milestones');
  await browser.close();
}

try {
  await migration();
  await run('mobile', { width: 390, height: 844 }, !shots);
  await run('desktop', { width: 1280, height: 860 }, true);
} finally { server.close(); }
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
