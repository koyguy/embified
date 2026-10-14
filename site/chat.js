/* Embified scripted signup assistant (no AI, no network calls). State lives in localStorage. */
(function () {
  'use strict';
  const CFG = window.EMBIFIED_SITE || {};
  const SITE = String(CFG.SITE_URL || (location.origin + location.pathname.replace(/\/[^/]*$/, ''))).replace(/\/$/, '');
  const INSTALL_CMD = 'bash <(curl -fsSL ' + SITE + '/install/oci-launch.sh)';
  const KEY = 'embified.chat.v2';
  const OLD_KEY = 'embified.chat.v1'; // XP-era progress, migrated once below
  const QUEST_KEY = 'embified.start.v1';
  const FAST = /[?&]fast=1\b/.test(location.search);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- state ----------
  function rid(n) {
    const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const a = new Uint8Array(n); crypto.getRandomValues(a);
    return Array.from(a, (b) => abc[b % abc.length]).join('');
  }
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null') || {}; } catch { return {}; } }
  const quest = load(QUEST_KEY); // share the referral identity with the checklist quest
  // One-time migration from the XP version: map old milestones to vault stages, drop XP/badge bubbles.
  function migrate() {
    let raw = null; try { raw = localStorage.getItem(KEY); } catch { /* private mode */ }
    if (raw) return load(KEY);
    const old = load(OLD_KEY);
    if (!old || !Object.keys(old).length) return {};
    const e = old.earned || {}; const built = {};
    if (e.signup) { built.claim = true; built.lock = true; }
    if (e.shell) built.keys = true;
    if (e.launch) built.build = true;
    if (e.whatsapp) { built.connect = true; built.protect = true; }
    const log = (old.log || []).filter((m) => !(m.who === 'sys' && /XP|badge/.test(m.html)) && !/XP|Vault Keeper/.test(m.html));
    return { log, node: old.node || null, back: old.back || null, built, region: old.region || null, vault: old.vault || null,
      myRef: old.myRef, ref: old.ref, welcomed: old.welcomed, archivedAt: e.whatsapp ? new Date().toISOString() : null, migrated: true };
  }
  const state = Object.assign({ log: [], node: null, back: null, built: {}, region: null, vault: null, archivedAt: null, nudged: {} }, migrate());
  state.built = state.built || {}; state.nudged = state.nudged || {};
  state.myRef = state.myRef || quest.myRef || rid(8);
  state.ref = state.ref || quest.ref || null;
  const inRef = (new URLSearchParams(location.search).get('ref') || '').trim();
  if (/^[A-Za-z0-9_-]{1,32}$/.test(inRef) && inRef !== state.myRef && !state.ref) state.ref = inRef;
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ } }

  // ---------- vault progress (no points: progress is the customer's vault being built) ----------
  // w = share of the vault, min = honest minutes for that stage (sums to ~30).
  const STAGES = [
    { k: 'claim', icon: '🌱', name: 'Claim your free space', w: 15, min: 7, won: 'Your free cloud space is claimed — your Oracle account exists.' },
    { k: 'lock', icon: '🔒', name: 'Lock it with your card check', w: 15, min: 3, won: 'Your 150 GB is reserved for you.' },
    { k: 'keys', icon: '🔑', name: 'Get your keys', w: 10, min: 3, won: "You're inside your own cloud. Only you hold the keys." },
    { k: 'build', icon: '🏗️', name: 'Build your vault', w: 30, min: 13, won: "Your vault server exists — in your account, nobody else's." },
    { k: 'connect', icon: '📱', name: 'Connect WhatsApp', w: 20, min: 3, won: 'WhatsApp connected. Your archive starts today.' },
    { k: 'protect', icon: '🛡️', name: 'Protected', w: 10, min: 1, won: 'Your group history is protected.' },
  ];
  const pct = () => STAGES.reduce((s, x) => s + (state.built[x.k] ? x.w : 0), 0);
  const minsLeft = () => STAGES.reduce((s, x) => s + (state.built[x.k] ? 0 : x.min), 0);
  const statusLine = () => {
    const p = pct(), m = minsLeft();
    if (p >= 100) return 'Your vault is built and protected';
    return `Your vault is ${p}% built · ${m <= 1 ? 'about a minute' : 'about ' + m + ' minutes'} left`;
  };
  // Next step for the resume message, by where the customer is in the script.
  function nextStep(node) {
    const n = (node === 'faq' || /^faq_/.test(node || '')) ? (state.back || 'start') : (node || 'start');
    if (/^(start|path|card|card_unsure|card_no|region)$/.test(n)) return 'choose where your vault lives';
    if (n === 'card_step') return 'the card check (about US$1, reversed right away)';
    if (/^(signup|signup_resume|stuck|st_|charge)/.test(n)) return 'create your Oracle account';
    if (/^(signin|shell_help)$/.test(n)) return 'open Cloud Shell';
    if (/^(command|cmd_|err_)/.test(n)) return 'Cloud Shell';
    if (/^paste/.test(n)) return 'paste your vault link';
    if (/^qr/.test(n)) return 'connect WhatsApp';
    return 'all done';
  }
  function vaultSvg() {
    // A round vault door: six arcs light up as stages complete; the hub locks at 100%.
    const cx = 18, cy = 18, r = 14, gap = 0.12;
    const arcs = STAGES.map((x, i) => {
      const a0 = -Math.PI / 2 + i * (Math.PI / 3) + gap, a1 = a0 + Math.PI / 3 - 2 * gap;
      const p = (a) => (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2);
      return `<path d="M${p(a0)} A${r} ${r} 0 0 1 ${p(a1)}" class="arc${state.built[x.k] ? ' on' : ''}"/>`;
    }).join('');
    return `<svg viewBox="0 0 36 36" width="34" height="34" aria-hidden="true">${arcs}<circle cx="18" cy="18" r="6" class="hub${pct() >= 100 ? ' on' : ''}"/></svg>`;
  }
  function hud() {
    const p = pct();
    $('vaultdoor').innerHTML = vaultSvg();
    $('pct').textContent = p + '%';
    $('vstatus').textContent = statusLine();
    const bar = $('vaultbar'); bar.setAttribute('aria-valuenow', String(p)); bar.setAttribute('aria-valuetext', statusLine());
    $('stages').innerHTML = STAGES.map((x) => `<li class="${state.built[x.k] ? 'on' : ''}" title="${esc(x.name)}"><span aria-hidden="true">${x.icon}</span><small>${esc(x.name)}</small><span class="sr">${state.built[x.k] ? ' (done)' : ' (to do)'}</span></li>`).join('');
  }
  function build(k) {
    const st = STAGES.find((x) => x.k === k);
    if (!st || state.built[k]) return;
    state.built[k] = true;
    if (k === 'connect' && !state.archivedAt) state.archivedAt = new Date().toISOString();
    save(); hud();
    addMsg('sys', `${st.icon} ${esc(st.won)}<br><span class="sub">${esc(statusLine())}</span>`);
    try { if (navigator.vibrate) navigator.vibrate(25); } catch { /* ignore */ }
    confetti(k === 'protect' ? 200 : 30, k === 'protect' ? 0.3 : 0.6);
  }
  // Gentle nudges when someone pauses at a drop-off point (card check, the command). Shown once each.
  let nudgeTimer = 0;
  function armNudge(id) {
    clearTimeout(nudgeTimer);
    const node = N[id];
    if (!node || !node.nudge || state.nudged[id]) return;
    nudgeTimer = setTimeout(() => fireNudge(id), FAST ? 60000 : 20000);
  }
  function fireNudge(id) {
    if (state.node !== id || state.nudged[id] || busy || !N[id] || !N[id].nudge) return;
    state.nudged[id] = true; addMsg('bot', resolveText(N[id].nudge));
  }

  // ---------- small content helpers ----------
  const btn = (href, label) => `<a class="cta" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;
  const code = (text) => `<div class="code"><code>${esc(text)}</code><button type="button" class="copy" data-copy="${esc(text)}">Copy</button></div>`;
  const REGIONS = {
    'ap-hyderabad-1': 'India South (Hyderabad)', 'ap-mumbai-1': 'India West (Mumbai)', 'ap-singapore-1': 'Singapore',
    'me-dubai-1': 'UAE East (Dubai)', 'uk-london-1': 'UK South (London)', 'us-ashburn-1': 'US East (Ashburn)',
  };
  const regionName = () => REGIONS[state.region] || 'the region you picked';
  const inviteUrl = () => SITE + '/?ref=' + state.myRef;
  const inviteMsg = () => "I set up a free private vault that keeps our WhatsApp group history forever, on my own server, not some company's. WhatsApp only keeps history on your phone; lose or switch phones and it's gone. Yours is free and takes about 30 minutes: " + inviteUrl();
  const fmtDate = (iso) => { const d = iso ? new Date(iso) : new Date(); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  function cardData() {
    return { link: state.vault || '(your vault link from Cloud Shell)', storage: '150 GB, reserved for you (Oracle Always Free)', region: REGIONS[state.region] || 'Your Oracle home region', wa: 'Connected', since: fmtDate(state.archivedAt) };
  }
  function summaryCard() {
    const c = cardData();
    return `<div class="vcard"><div class="vc-head"><span aria-hidden="true">🛡️</span><div><b>My private WhatsApp archive</b><small>Embified vault · on my own server</small></div></div>
<dl><dt>Vault link</dt><dd>${esc(c.link)}</dd><dt>Storage</dt><dd>${esc(c.storage)}</dd><dt>Region</dt><dd>${esc(c.region)}</dd><dt>WhatsApp</dt><dd>✓ ${esc(c.wa)}</dd><dt>Archive started</dt><dd>${esc(c.since)}</dd></dl>
<p class="vc-note">Keep your inbox password from Cloud Shell with this card. Nobody else has a copy.</p>
<div class="vc-actions"><button type="button" class="savecard" data-act="png">⬇ Save this card</button><button type="button" class="savecard ghostbtn" data-act="print">🖨 Print</button></div></div>`;
  }
  const validVault = (u) => /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?(login)?\/?$/i.test(u) || /^https?:\/\/(\d{1,3}\.){3}\d{1,3}\/?(login)?\/?$/.test(u) || /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/?$/i.test(u);

  // ---------- the script ----------
  // node: { say: [html|fn], replies: [{label, go, href, primary, do}], input: bool, onEnter: fn }
  const N = {
    start: {
      say: [
        `Hi! 👋 I'm the <b>Embified assistant</b>. WhatsApp only keeps your group history <b>on your phone</b>. Switch or lose your phone and years of photos, voice notes and plans are gone.`,
        () => state.ref ? `🎁 A friend sent you this so your history is safe too.` : '',
        `I'll help you build <b>your own private vault</b>: your group history, kept forever, <b>on your own server, nobody else's</b>. It's a free 150 GB, roughly 20+ years of group chats even for a busy account.`,
        `<b>About 30 minutes. At the end you'll have your own private archive.</b> I do the technical bits; you only do what needs you. Ready?`,
      ],
      replies: [{ label: "Let's build my vault", go: 'path', primary: true }, { label: 'Is it really free?', go: 'faq_free' }],
    },
    path: {
      say: [`Where should your vault live?`, `<b>Oracle Cloud (recommended)</b> — free forever, always on, 150 GB vault disk. Needs a card for a one-time check.<br><b>Home box</b> — an old laptop/PC or Raspberry Pi at home.<br><b>Official Cloud API</b> — for WhatsApp Business numbers.`],
      replies: [
        { label: '☁️ Oracle free (recommended)', go: 'card', primary: true },
        { label: '🏠 Home box', href: 'home-setup.html' },
        { label: '🏢 Cloud API', href: 'cloud-setup.html' },
      ],
    },
    card: {
      say: [`Quick check before we start: Oracle verifies you with a <b>credit or debit card</b>. Do you have one with <b>international / online transactions enabled</b>?`, `<small>Prepaid, gift and virtual cards are not accepted by Oracle.</small>`],
      replies: [
        { label: '✅ Yes, I have one', go: 'region', primary: true },
        { label: 'Not sure', go: 'card_unsure' },
        { label: 'Only prepaid / virtual', go: 'card_no' },
      ],
    },
    card_unsure: {
      say: [`Open your bank app and look for <b>card controls</b> or <b>manage limits</b>. Turn on <b>international</b> and <b>online / e-commerce</b> use. Most Indian debit and credit cards (Visa, Mastercard, RuPay with international) work once that's on.`, `You can switch it back off after signup.`],
      replies: [{ label: "Done, it's enabled", go: 'region', primary: true }, { label: 'Only prepaid / virtual', go: 'card_no' }],
    },
    card_no: {
      say: [`Oracle won't accept those, sorry. Options: use a family member's regular card (with their OK; the name on the account must match the card), get your bank to enable international use on a regular debit card, or go the free <b>home box</b> route with no card at all.`],
      replies: [{ label: 'I found a card', go: 'region', primary: true }, { label: '🏠 Use a home box', href: 'home-setup.html' }],
    },
    region: {
      say: [`Now pick your <b>home region</b>. ⚠️ It's <b>permanent</b> — free servers only run there. Pick the one closest to you and your WhatsApp contacts.`, `For India, <b>Hyderabad</b> or <b>Mumbai</b> are best.`],
      replies: [
        { label: '🇮🇳 Hyderabad', go: 'signup', primary: true, do: () => setRegion('ap-hyderabad-1') },
        { label: '🇮🇳 Mumbai', go: 'signup', do: () => setRegion('ap-mumbai-1') },
        { label: '🇸🇬 Singapore', go: 'signup', do: () => setRegion('ap-singapore-1') },
        { label: '🇦🇪 Dubai', go: 'signup', do: () => setRegion('me-dubai-1') },
        { label: 'Somewhere else', go: 'signup', do: () => setRegion('other') },
      ],
    },
    signup: {
      say: [
        () => `Great — <b>${esc(regionName())}</b> it is. Now create your Oracle account. It opens in a new tab; keep this chat open and come back.`,
        `${btn('https://signup.cloud.oracle.com/', 'Open Oracle signup ↗')}`,
        `<ol><li>Enter your country, name and email, then <b>verify your email</b> (check spam).</li><li>Set a <b>password</b> and a cloud account name (any short name).</li><li>Home region: choose <b>${'{R}'}</b>.</li><li>Address: use the <b>same name and address as your card</b>.</li><li>Stop when Oracle asks for your <b>card</b> and tell me — I'll walk you through it.</li></ol>`,
      ],
      replies: [
        { label: "💳 I'm at the card step", go: 'card_step', primary: true, do: () => build('claim') },
        { label: "😕 I'm stuck", go: 'stuck' },
        { label: "💳 What's this charge?", go: 'charge' },
      ],
    },
    card_step: {
      say: [
        `This is the step that <b>locks your space to you</b>. Enter your card on Oracle's page (we never see it). Use the <b>same name and address as the card</b>; your bank may ask for an OTP.`,
        `Oracle places a <b>~US$1 check and reverses it immediately</b>. Always Free never charges you. Then wait for “Your account is ready” (a few minutes).`,
      ],
      nudge: `Still there? Totally normal to pause here. 💳 Oracle reverses the ~US$1 check immediately, and <b>Always Free never charges</b> unless you choose to upgrade. Stopping now means your group history keeps living only on your phone.`,
      replies: [
        { label: '🔒 Card verified, account ready', go: 'signin', primary: true, do: () => build('lock') },
        { label: "💳 What's this charge?", go: 'charge' },
        { label: "😕 I'm stuck", go: 'stuck' },
      ],
    },
    charge: {
      say: [`It's a <b>verification hold of about US$1</b> (₹80–90 shown by some banks), reversed right away. Oracle uses it to make sure you're a real person. <b>Always Free resources never charge you</b>, and your account won't bill you unless you choose to upgrade.`],
      replies: [{ label: 'Got it, back to signup', go: 'signup_resume', primary: true }, { label: "I'm stuck", go: 'stuck' }],
    },
    signup_resume: {
      say: [`OK! Finish the signup tab. Tell me when you reach the card step, or when you see “Your account is ready”.`, () => btn('https://signup.cloud.oracle.com/', 'Open Oracle signup ↗')],
      replies: [
        { label: "💳 I'm at the card step", go: 'card_step', primary: true, do: () => build('claim') },
        { label: '🔒 Card verified, account ready', go: 'signin', do: () => { build('claim'); build('lock'); } },
        { label: "😕 I'm stuck", go: 'stuck' },
      ],
    },
    stuck: {
      say: [`No problem — what's happening?`],
      replies: [
        { label: 'Card declined', go: 'st_card' },
        { label: "Email didn't arrive", go: 'st_email' },
        { label: '“Error processing transaction”', go: 'st_txn' },
        { label: 'Which region?', go: 'st_region' },
        { label: "I'm on a VPN", go: 'st_vpn' },
      ],
    },
    st_card: { say: [`Usually one of: international/online use is off (turn it on in your bank app), it's a prepaid/virtual card, or the <b>name/address doesn't match the card</b>. Fix that, wait 10 minutes, then retry in a <b>fresh private window</b>. Credit cards tend to pass more often than debit cards.`], replies: 'retry' },
    st_email: { say: [`Check spam/promotions for mail from <b>oracle.com</b>. Wait 5 minutes, then resend. Gmail and Outlook work best; some work or school addresses block it.`], replies: 'retry' },
    st_txn: { say: [`That's Oracle's fraud filter, not your bank. Try: turn off any VPN or ad-blocker, use a normal (non-incognito) Chrome window on your phone's mobile data, keep name/address identical to the card, and wait 24 hours before retrying. If it repeats, a different card often works. Oracle support chat (on the signup page) can also clear it.`], replies: 'retry' },
    st_region: { say: [() => `Pick the region closest to you — you said <b>${esc(regionName())}</b>. It can't be changed later, and free servers only run in it. For India choose Hyderabad or Mumbai.`], replies: 'retry' },
    st_vpn: { say: [`Turn the VPN off. Oracle's signup blocks VPN and proxy traffic and may decline the card because of it. Use your normal home Wi-Fi or mobile data.`], replies: 'retry' },
    signin: {
      say: [
        `Your space is yours now. Next, sign in to the Oracle console with the account you just made.`,
        () => btn('https://cloud.oracle.com/?region=home', 'Open Oracle console ↗'),
        `Then open <b>Cloud Shell</b>: click the <b>&gt;_</b> (Developer tools) icon at the top right and choose <b>Cloud Shell</b>. A terminal opens at the bottom of the page. It's already signed in to your account — nothing to install.`,
      ],
      replies: [{ label: 'Cloud Shell is open', go: 'command', primary: true, do: () => build('keys') }, { label: "I can't find it", go: 'shell_help' }],
    },
    shell_help: {
      say: [`Look for a small square icon with <b>&gt;_</b> in the top bar, near the region name and the bell. On a phone, rotate to landscape or tap “Desktop site” in your browser menu — Cloud Shell is easier on a laptop. The first launch can take a minute.`],
      replies: [{ label: 'Found it, Cloud Shell is open', go: 'command', primary: true, do: () => build('keys') }],
    },
    command: {
      say: [
        `Here's the magic part ✨ Copy this and paste it into Cloud Shell, then press Enter:`,
        () => code(INSTALL_CMD),
        `It creates everything <b>inside your own account</b>: a compartment, an SSH key, a strong inbox password and your vault server. If Oracle's bigger free servers are busy, it automatically falls back to a smaller free one. No keys or passwords are sent to us.`,
        `It takes about <b>10–15 minutes</b> (this is the big one). When it finishes, it shows a box with your <b>vault link</b> and <b>inbox password</b>. Save both!`,
      ],
      replies: [
        { label: '✅ I got my vault link', go: 'paste', primary: true, do: () => build('build') },
        { label: 'It showed an error', go: 'cmd_error' },
        { label: 'What does it do exactly?', go: 'cmd_what' },
      ],
      nudge: `Your 150 GB is already reserved. This one command is what turns it into your vault. After it, your group history stops depending on one phone.`,
    },
    cmd_what: {
      say: [`Step by step: finds your account and home region → makes a compartment named <b>embified</b> → makes an SSH key in Cloud Shell → generates an inbox password → creates an Oracle Resource Manager stack from our open-source template → builds the server (150 GB free disk) → waits until the vault answers and has its https link.`, `You can preview it without creating anything by adding <code>--dry-run</code> at the end. The script is open source: <a href="https://github.com/koyguy/embified/tree/main/scripts/oci-cloudshell" target="_blank" rel="noopener">read it on GitHub</a>.`],
      replies: [{ label: 'OK, back to the command', go: 'command_resume', primary: true }],
    },
    cmd_error: {
      say: [`Which one?`],
      replies: [
        { label: '“No free capacity”', go: 'err_capacity' },
        { label: '“Limit reached”', go: 'err_limit' },
        { label: 'It timed out / I closed it', go: 'err_rerun' },
        { label: 'Something else', go: 'err_other' },
      ],
    },
    err_capacity: { say: [`Oracle's free servers are full in your region right now. That's common and temporary. Wait an hour and <b>run the same command again</b> — it picks up where it left off and tries every option.`], replies: 'cmd' },
    err_limit: { say: [`Your account already uses its free server or disk allowance (maybe from an earlier attempt). In the console go to <b>Compute → Instances</b> and <b>Block Storage</b>, delete anything you don't need, then run the command again.`], replies: 'cmd' },
    err_rerun: { say: [`That's fine — just paste the same command again. It reuses everything already created and continues. Your link and password are also saved in Cloud Shell: run <code>cat ~/embified-vault.txt</code>.`], replies: 'cmd' },
    err_other: { say: [`Run it again first — most hiccups are temporary. If it still fails, copy the red lines and ask the person who invited you, or open an issue on <a href="https://github.com/koyguy/embified/issues" target="_blank" rel="noopener">GitHub</a>.`], replies: 'cmd' },
    command_resume: {
      say: [() => code(INSTALL_CMD), `Paste it in Cloud Shell and press Enter.`],
      replies: [{ label: '✅ I got my vault link', go: 'paste', primary: true, do: () => build('build') }, { label: 'It showed an error', go: 'cmd_error' }],
    },
    paste: {
      say: [`Your vault is alive. Paste your <b>vault link</b> here (it looks like <code>https://something.trycloudflare.com</code>). I'll keep it in this browser only.`],
      input: true,
      replies: [{ label: "I didn't save it", go: 'paste_lost' }],
    },
    paste_lost: {
      say: [`It's saved in Cloud Shell. Run this there:`, () => code('cat ~/embified-vault.txt'), `It shows the link and your inbox password.`],
      input: true, replies: [],
    },
    qr: {
      say: [
        () => `Last step: connect WhatsApp. Open your vault and sign in with the inbox password from Cloud Shell.`,
        () => btn(state.vault || '#', 'Open my vault ↗'),
        `<ol><li>On your phone, open <b>WhatsApp → Settings → Linked devices → Link a device</b>.</li><li>Scan the QR code shown in your vault.</li><li>Keep WhatsApp open for a few minutes so recent group history syncs.</li></ol>`,
      ],
      replies: [{ label: '📱 I scanned it', go: 'done', primary: true, do: () => build('connect') }, { label: "The page won't open", go: 'qr_help' }],
    },
    qr_help: {
      say: [`The https link can take a few minutes to start after the server finishes installing. Wait 5 minutes and try again. If the link changed, run <code>cat ~/embified-vault.txt</code> in Cloud Shell or use the <b>http://IP/</b> backup link it printed — that always forwards to the current one.`],
      replies: [{ label: 'Paste a new link', go: 'paste' }, { label: '📱 It worked, I scanned it', go: 'done', primary: true, do: () => build('connect') }],
    },
    done: {
      onEnter: () => { build('connect'); build('protect'); },
      say: [
        `Done. From today, every group message, photo and voice note is kept on <b>your own server</b>. Lose or switch your phone and it's still here.`,
        () => summaryCard(),
        `<b>Give a friend their own free vault.</b> Everyone has a group they'd hate to lose. Here's a message you can send:`,
        () => `<blockquote class="invite">${esc(inviteMsg())}</blockquote>`,
        () => code(inviteUrl()),
      ],
      replies: [
        { label: '🎁 Send a friend their vault', href: () => 'https://wa.me/?text=' + encodeURIComponent(inviteMsg()), primary: true },
        { label: 'Open my vault', href: () => state.vault || '#' },
        { label: '❓ FAQ', go: 'faq' },
      ],
    },
    faq: {
      say: [`Ask me anything below 👇`],
      replies: [
        { label: 'Is it really free?', go: 'faq_free' },
        { label: 'Why a card?', go: 'faq_card' },
        { label: 'Who can see my chats?', go: 'faq_privacy' },
        { label: 'Can Oracle take it back?', go: 'faq_reclaim' },
        { label: 'Linked device vs Cloud API', go: 'faq_api' },
      ],
    },
    faq_free: { say: [`Yes. It uses Oracle's <b>Always Free</b> tier: a small server and up to 200 GB of disk (your vault uses 150 GB) that stay free as long as you use them, in your home region. Embified itself is free and open source. You're never charged unless you upgrade your Oracle account on purpose.`], replies: 'faq' },
    faq_card: { say: [`Oracle uses a card to stop abuse. It places a <b>~US$1 hold that's reversed immediately</b>. Embified never sees your card — you type it only on Oracle's own page.`], replies: 'faq' },
    faq_privacy: { say: [`Only you. Your messages are stored on <b>your</b> Oracle server, behind your own password over https. We don't run a copy and this site sends nothing anywhere — even this chat's progress stays in your browser.`], replies: 'faq' },
    faq_reclaim: { say: [`Oracle can reclaim free servers that sit idle (very low CPU and network for 7 days). Embified installs a tiny keep-alive that keeps it above that line. Also sign in to Oracle every month or two so the account stays active.`], replies: 'faq' },
    faq_api: { say: [`<b>Linked device</b> (default) works like WhatsApp Web on your normal number and captures all your groups. The <b>official Cloud API</b> is for WhatsApp Business numbers; it's more formal but can't read groups the same way. Most people want linked device.`], replies: 'faq' },
  };
  // shared reply sets
  const SETS = {
    retry: [{ label: 'Try again', go: 'signup_resume', primary: true }, { label: 'Something else', go: 'stuck' }, { label: "💳 What's this charge?", go: 'charge' }],
    cmd: [{ label: 'Show the command again', go: 'command_resume', primary: true }, { label: '✅ I got my vault link', go: 'paste', do: () => build('build') }],
    faq: [{ label: 'More questions', go: 'faq' }],
  };
  function setRegion(r) { state.region = r; save(); }

  // ---------- rendering ----------
  const logEl = $('log');
  function bubble(who, html) {
    const d = document.createElement('div');
    d.className = 'msg ' + who;
    d.innerHTML = `<div class="b">${html}</div>`;
    logEl.appendChild(d);
    requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; window.scrollTo(0, document.documentElement.scrollHeight); });
    return d;
  }
  function addMsg(who, html) { state.log.push({ who, html }); if (state.log.length > 300) state.log.splice(0, 50); save(); bubble(who, html); }
  const wait = (ms) => new Promise((r) => setTimeout(r, FAST ? 0 : ms));
  let busy = 0;

  function resolveText(s) { return (typeof s === 'function' ? s() : s).replace('{R}', esc(regionName())); }
  function repliesFor(node) {
    const rs = typeof node.replies === 'string' ? SETS[node.replies] : (node.replies || []);
    // From FAQ answers, offer a way back to wherever the customer was.
    if (node.replies === 'faq' && state.back && state.back !== 'faq') return rs.concat([{ label: '↩ Back to setup', go: state.back, resume: true, primary: true }]);
    if (state.node === 'faq' && state.back) return rs.concat([{ label: '↩ Back to setup', go: state.back, resume: true, primary: true }]);
    return rs;
  }
  function showReplies() {
    const node = N[state.node]; const box = $('replies'); box.innerHTML = '';
    for (const r of repliesFor(node)) {
      const el = document.createElement(r.href ? 'a' : 'button');
      el.textContent = r.label;
      if (r.primary) el.className = 'primary';
      if (r.href) {
        el.href = typeof r.href === 'function' ? r.href() : r.href;
        if (/^https?:/.test(el.href) && !el.href.startsWith(location.origin)) { el.target = '_blank'; el.rel = 'noopener'; }
      } else {
        el.type = 'button';
        el.addEventListener('click', () => choose(r));
      }
      box.appendChild(el);
    }
    $('inputrow').classList.toggle('hidden', !node.input);
    if (node.input) $('text').focus({ preventScroll: true });
    requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; });
  }
  async function go(id, opts) {
    const node = N[id]; if (!node) return;
    busy++;
    if (!(opts && opts.resume) && !id.startsWith('faq')) state.back = null;
    state.node = id; save();
    $('replies').innerHTML = ''; $('inputrow').classList.add('hidden');
    if (node.onEnter) node.onEnter();
    for (const s of node.say) {
      const html = resolveText(s); if (!html) continue;
      const t = bubble('bot typing', '<i></i><i></i><i></i>');
      $('status').textContent = 'typing…';
      await wait(Math.min(1100, 350 + html.replace(/<[^>]+>/g, '').length * 4));
      t.remove(); addMsg('bot', html);
    }
    $('status').textContent = 'online · free setup';
    busy--;
    showReplies();
    armNudge(id);
  }
  function choose(r) {
    if (busy) return;
    addMsg('me', esc(r.label));
    if (r.do) r.do();
    if (r.go && r.go.startsWith('faq') && !state.node.startsWith('faq')) state.back = state.node;
    go(r.go, { resume: r.resume });
  }

  // vault link input
  $('inputrow').addEventListener('submit', (e) => {
    e.preventDefault();
    let v = $('text').value.trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    addMsg('me', esc(v));
    $('text').value = '';
    if (!validVault(v)) {
      addMsg('bot', `Hmm, that doesn't look like a vault link. It should look like <code>https://word-word-word.trycloudflare.com</code> or <code>http://1.2.3.4/</code>. Try again?`);
      return;
    }
    state.vault = v.replace(/\/login\/?$/, '/').replace(/([^/])$/, '$1/');
    save(); go('qr');
  });

  // copy buttons (event delegation)
  logEl.addEventListener('click', async (e) => {
    const sc = e.target.closest('.savecard');
    if (sc) { if (sc.dataset.act === 'print') printCard(); else saveCardPng(); return; }
    const b = e.target.closest('.copy'); if (!b) return;
    const text = b.getAttribute('data-copy');
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    b.textContent = ok ? 'Copied ✓' : 'Select & copy'; b.classList.toggle('done', ok);
    setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 2000);
  });

  $('faqbtn').addEventListener('click', () => { if (busy) return; if (!state.node.startsWith('faq')) state.back = state.node; addMsg('me', 'FAQ'); go('faq', { resume: true }); });
  $('restart').addEventListener('click', () => {
    if (!confirm('Start the chat over? Your invite code is kept.')) return;
    const keep = { myRef: state.myRef, ref: state.ref };
    try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* ignore */ }
    location.reload();
  });

  // ---------- summary card: save as image (drawn locally on a canvas) or print ----------
  function saveCardPng() {
    const c = cardData(); const W = 720, H = 460, sc = 2;
    const cv = document.createElement('canvas'); cv.width = W * sc; cv.height = H * sc;
    const g = cv.getContext('2d'); g.scale(sc, sc);
    g.fillStyle = '#0b1410'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#122018'; g.strokeStyle = '#25d366'; g.lineWidth = 2;
    g.fillRect(20, 20, W - 40, H - 40); g.strokeRect(20, 20, W - 40, H - 40);
    const font = (w, px) => w + ' ' + px + 'px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    g.fillStyle = '#e8f5ee'; g.font = font('800', 28); g.fillText('My private WhatsApp archive', 48, 78);
    g.fillStyle = '#8aa897'; g.font = font('500', 16); g.fillText("Embified vault · on my own server, nobody else's", 48, 106);
    const rows = [['Vault link', c.link], ['Storage', c.storage], ['Region', c.region], ['WhatsApp', '✓ ' + c.wa], ['Archive started', c.since]];
    rows.forEach(([k, v], i) => {
      const y = 160 + i * 50;
      g.fillStyle = '#8aa897'; g.font = font('600', 15); g.fillText(k, 48, y);
      g.fillStyle = '#e8f5ee'; g.font = font('700', 18);
      let t = v; while (g.measureText(t + '…').width > W - 260 && t.length > 4) t = t.slice(0, -1);
      g.fillText(t === v ? v : t + '…', 210, y);
    });
    g.fillStyle = '#25d366'; g.font = font('600', 14); g.fillText('Keep your inbox password with this card. Nobody else has a copy.', 48, H - 52);
    const a = document.createElement('a'); a.download = 'my-embified-vault.png'; a.href = cv.toDataURL('image/png');
    document.body.appendChild(a); a.click(); a.remove(); toast('Card saved to your downloads');
  }
  function printCard() {
    const cards = logEl.querySelectorAll('.vcard'); const last = cards[cards.length - 1]; if (!last) return;
    last.classList.add('printme'); document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); last.classList.remove('printme'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done); window.print(); setTimeout(done, 1500);
  }

  // ---------- confetti ----------
  const canvas = $('confetti'); const ctx = canvas.getContext('2d');
  let parts = []; let raf = 0;
  function confetti(count, originY) {
    if (FAST || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ['#25d366', '#7cf0a8', '#ffd166', '#ffffff', '#f07178', '#4cc9f0'];
    for (let i = 0; i < count; i++) parts.push({ x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.4, y: innerHeight * originY, vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 12 - 4, s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: colors[(Math.random() * colors.length) | 0], life: 0 });
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life < 160 && p.y < innerHeight + 20);
    for (const p of parts) {
      p.life++; p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.globalAlpha = Math.max(0, 1 - p.life / 160);
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
    }
    raf = parts.length ? requestAnimationFrame(tick) : 0;
  }
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 2600); }

  // ---------- boot / resume ----------
  hud();
  if (state.log.length && state.node && N[state.node]) {
    for (const m of state.log) bubble(m.who, m.html);
    bubble('sys', pct() >= 100 ? '↺ Welcome back — your vault is built and protected' : `↺ Welcome back — your vault is ${pct()}% built, next step: ${esc(nextStep(state.node))}`);
    if (state.migrated) { delete state.migrated; save(); }
    armNudge(state.node);
    showReplies();
  } else {
    state.log = []; go('start');
  }
  if (state.ref && !state.welcomed) { state.welcomed = true; save(); setTimeout(() => toast('🎁 A friend sent you your own free vault'), 600); }
  window.__embifiedChat = { state, nodes: N, installCmd: INSTALL_CMD, stages: STAGES, pct, nudge: () => fireNudge(state.node) };
})();
