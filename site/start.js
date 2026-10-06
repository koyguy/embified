/* Embified signup quest (static site index). Progress lives in localStorage only. */
(function () {
  'use strict';
  // Site config lives in config.js (no build step). See docs/PUBLIC_SITE.md.
  const CFG = window.EMBIFIED_SITE || {};
  const ANALYTICS_URL = String(CFG.ANALYTICS_URL || '').trim();
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const ZIP_URL = 'https://github.com/koyguy/embified/releases/download/orm-stack/embified-oci-stack.zip';
  const KEY = 'embified.start.v1';
  const REF_BONUS = 50;
  const LEVELS = [
    { n: 1, xp: 100, min: 10, badge: '🌱', name: 'Cloud Citizen' },
    { n: 2, xp: 150, min: 3, badge: '💳', name: 'Verified Human' },
    { n: 3, xp: 50, min: 1, badge: '🧭', name: 'Console Cadet' },
    { n: 4, xp: 100, min: 2, badge: '🔎', name: 'OCID Hunter' },
    { n: 5, xp: 100, min: 1, badge: '🔑', name: 'Keymaster' },
    { n: 6, xp: 250, min: 12, badge: '🚀', name: 'Launch Commander' },
    { n: 7, xp: 250, min: 6, badge: '🏆', name: 'Vault Keeper' },
  ];
  const RANKS = [
    [0, 'Newcomer'], [100, 'Explorer'], [250, 'Verified'], [450, 'Builder'], [700, 'Launcher'], [1000, 'Vault Keeper'],
  ];

  // ---------- state ----------
  function rid(n) {
    const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => abc[b % abc.length]).join('');
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch { return {}; }
  }
  const state = Object.assign({ done: {}, skipped: {}, data: {}, current: 1, path: null, shared: false }, load());
  state.cid = state.cid || rid(16);
  state.myRef = state.myRef || rid(8);
  state.data = Object.assign({ region: 'ap-hyderabad-1' }, state.data);
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
  }

  const q = new URLSearchParams(location.search);
  const incomingRef = (q.get('ref') || '').trim();
  if (/^[A-Za-z0-9_-]{1,32}$/.test(incomingRef) && incomingRef !== state.myRef && !state.ref) {
    state.ref = incomingRef;
  }
  save();

  // ---------- analytics (anonymous, opt-in) ----------
  // No-op unless config.js sets ANALYTICS_URL (an HTTPS endpoint that accepts CORS JSON POSTs).
  function track(event, level) {
    if (!/^https:\/\//.test(ANALYTICS_URL)) return;
    try {
      const body = JSON.stringify({ event, cid: state.cid, level, ref: state.ref });
      fetch(ANALYTICS_URL, { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    } catch { /* never block the funnel */ }
  }

  // ---------- helpers ----------
  const doneCount = () => LEVELS.filter((l) => state.done[l.n]).length;
  function xp() {
    return LEVELS.reduce((s, l) => s + (state.done[l.n] ? l.xp : 0), 0) + (state.ref ? REF_BONUS : 0);
  }
  const xpMax = () => LEVELS.reduce((s, l) => s + l.xp, 0) + (state.ref ? REF_BONUS : 0);
  function rankFor(v) {
    let r = RANKS[0][1];
    for (const [t, name] of RANKS) if (v >= t) r = name;
    return r;
  }
  const validOcid = (s) => /^ocid1\.(tenancy|compartment)\.oc[0-9]+\.[A-Za-z0-9._-]*\.[A-Za-z0-9]{20,}$/.test(s || '');
  const validSsh = (s) => /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]{40,}( .*)?$/.test((s || '').trim());
  const validHost = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s || '') || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s || '');
  const host = () => (state.data.ip || '').trim();
  const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function download(name, text) {
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove(); return ok;
    }
  }

  // ---------- confetti ----------
  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  let parts = [];
  let raf = 0;
  function confetti(count, originY) {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ['#25d366', '#7cf0a8', '#ffd166', '#ffffff', '#f07178', '#4cc9f0'];
    for (let i = 0; i < count; i++) {
      parts.push({
        x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.4,
        y: innerHeight * (originY == null ? 0.35 : originY),
        vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 12 - 4,
        s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        c: colors[(Math.random() * colors.length) | 0], life: 0,
      });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life < 160 && p.y < innerHeight + 20);
    for (const p of parts) {
      p.life++; p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      ctx.globalAlpha = Math.max(0, 1 - p.life / 160);
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
    }
    raf = parts.length ? requestAnimationFrame(tick) : 0;
    if (!raf) ctx.clearRect(0, 0, innerWidth, innerHeight);
  }

  // ---------- rendering ----------
  function renderBadges(popN) {
    const extra = [];
    if (state.ref) extra.push({ k: 'ref', badge: '🎁', name: 'Invited', on: true });
    extra.push({ k: 'share', badge: '📣', name: 'Ambassador', on: !!state.shared });
    const html = LEVELS.map((l) =>
      `<div class="badge ${state.done[l.n] ? 'on' : ''} ${popN === l.n ? 'pop' : ''}" title="Level ${l.n}"><i>${l.badge}</i>${l.name}</div>`
    ).concat(extra.map((b) => `<div class="badge ${b.on ? 'on' : ''} ${popN === b.k ? 'pop' : ''}"><i>${b.badge}</i>${b.name}</div>`));
    $('badges').innerHTML = html.join('');
  }

  function render(popN) {
    const v = xp();
    const max = xpMax();
    const pct = Math.min(100, Math.round((v / max) * 100));
    $('xp').textContent = v;
    $('xp-top').textContent = v;
    $('xp-max').textContent = max;
    $('bar-fill').style.width = pct + '%';
    $('minibar-fill').style.width = pct + '%';
    $('bar').setAttribute('aria-valuenow', String(pct));
    $('rank').textContent = rankFor(v);
    const left = LEVELS.filter((l) => !state.done[l.n]).reduce((s, l) => s + l.min, 0);
    $('time-left').textContent = left ? `~${left} min left` : 'All done!';
    $('lvl-label').textContent = `Level ${state.current} of ${LEVELS.length} · ${doneCount()} done`;
    renderBadges(popN);

    $$('.level').forEach((li) => {
      const n = Number(li.dataset.level);
      li.classList.toggle('done', !!state.done[n]);
      li.classList.toggle('skipped', !!state.skipped[n] && !state.done[n]);
      li.classList.toggle('current', n === state.current);
      li.classList.toggle('open', n === state.current);
    });

    // nav
    $('nav-back').disabled = state.current <= 1;
    const cur = state.current;
    const isDone = !!state.done[cur];
    const gate = gateFor(cur);
    $('nav-done').disabled = !isDone && !gate.ok;
    $('nav-done').textContent = isDone ? (cur < 7 ? 'Next level →' : 'See my vault 🏆') : `I did this ✓ +${LEVELS[cur - 1].xp}`;
    $('nav-skip').classList.toggle('hidden', isDone || cur >= 7);
    $('nav-note').textContent = !isDone && !gate.ok ? gate.msg : '';

    // CTA
    const started = doneCount() > 0 || state.path === 'oracle';
    $('cta-main').textContent = doneCount() === 7 ? 'Open my quest 🏆' : started ? `Continue — Level ${firstOpen()} →` : 'Start my free vault →';
    $('refbanner').classList.toggle('hidden', !state.ref);
    $$('.path').forEach((b) => b.classList.toggle('sel', b.dataset.path === state.path));

    renderDynamic();
  }

  function gateFor(n) {
    const d = state.data;
    if (n === 4 && !validOcid(d.compartment)) return { ok: false, msg: 'Paste a valid OCID above to claim this level (or skip).' };
    if (n === 5 && !validSsh(d.sshpub)) return { ok: false, msg: 'Generate or paste an SSH public key to claim this level.' };
    if (n === 6 && !validHost(host())) return { ok: false, msg: 'Paste your vault’s public IP from the stack Outputs to claim this level.' };
    return { ok: true, msg: '' };
  }

  function firstOpen() {
    const l = LEVELS.find((x) => !state.done[x.n]);
    return l ? l.n : 7;
  }

  function deployUrl() {
    const d = state.data;
    const vars = { region: d.region, display_name: 'embified-vault' };
    if (validOcid(d.compartment)) vars.compartment_ocid = d.compartment.trim();
    if (validSsh(d.sshpub)) vars.ssh_public_key = d.sshpub.trim();
    return (
      'https://cloud.oracle.com/resourcemanager/stacks/create?region=' + encodeURIComponent(d.region) +
      '&zipUrl=' + ZIP_URL +
      '&zipUrlVariables=' + encodeURIComponent(JSON.stringify(vars))
    );
  }

  function tfvars() {
    const d = state.data;
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return [
      '# Generated by the Embified signup quest (browser-only; not uploaded).',
      'compartment_ocid = "' + esc((d.compartment || '').trim()) + '"',
      'region           = "' + esc(d.region) + '"',
      'display_name     = "embified-vault"',
      'ssh_public_key   = "' + esc((d.sshpub || '').trim()) + '"',
      '',
    ].join('\n');
  }

  // Canonical site URL for invite links: config.js SITE_URL, else this page's directory.
  function siteBase() {
    const s = String(CFG.SITE_URL || '').trim();
    if (/^https?:\/\/[^\s]+$/.test(s)) return s.replace(/\/+$/, '');
    return (location.origin + location.pathname.replace(/[^/]*$/, '')).replace(/\/+$/, '');
  }

  function renderDynamic() {
    const d = state.data;
    $('console-link').href = 'https://cloud.oracle.com/?region=' + encodeURIComponent(d.region);
    $('tenancy-link').href = 'https://cloud.oracle.com/tenancy?region=' + encodeURIComponent(d.region);
    $('deploy').href = deployUrl();
    $('dl-zip').href = ZIP_URL;
    const filled = [];
    if (validOcid(d.compartment)) filled.push('compartment');
    filled.push('region ' + d.region);
    if (validSsh(d.sshpub)) filled.push('SSH key');
    $('deploy-hint').textContent = 'Pre-filled: ' + filled.join(' · ') + (filled.length < 3 ? ' — finish levels 4–5 to pre-fill everything, or fill them on Oracle’s page.' : ' ✓');

    const h = host();
    const ok = validHost(h);
    const base = ok ? 'http://' + h : null;
    $('health-link').href = base ? base + '/health' : '#ip';
    $('login-link').href = base ? base + '/login' : '#ip';
    $('open-vault').href = base ? base + '/' : '#';
    const keyFile = d.keyfile ? '~/Downloads/' + d.keyfile : '~/.ssh/embified_ed25519';
    const pw = $('pw').value;
    const pwLine = pw ? shellQuote('EMBIFIED_AUTH_PASSWORD=' + pw) : "'EMBIFIED_AUTH_PASSWORD=<your-password>'";
    $('pw-snippet').textContent = [
      '# 1) On your computer' + (d.keyfile ? ' (key downloaded in Level 5):' : ':'),
      d.keyfile ? 'chmod 600 ' + keyFile : '# (use the private key that matches the public key from Level 5)',
      'ssh -i ' + keyFile + ' ubuntu@' + (ok ? h : '<public_ip>'),
      '',
      '# 2) Now on the server:',
      'echo ' + pwLine + ' | sudo tee /etc/embified/auth.env >/dev/null',
      'sudo chmod 600 /etc/embified/auth.env',
      'sudo systemctl restart embified',
      'exit',
    ].join('\n');

    // field hints
    const oh = $('ocid-hint');
    if (d.compartment) { oh.textContent = validOcid(d.compartment) ? '✓ Looks right. Stays in this browser only.' : 'That doesn’t look like an OCID — it should start with ocid1.tenancy.oc1.. or ocid1.compartment.oc1..'; oh.className = 'hint ' + (validOcid(d.compartment) ? 'good' : 'bad'); }
    const sh = $('ssh-hint');
    if (d.sshpub) { sh.textContent = validSsh(d.sshpub) ? '✓ Valid public key.' : 'Paste the PUBLIC key (starts with ssh-ed25519 or ssh-rsa), never the private key.'; sh.className = 'hint ' + (validSsh(d.sshpub) ? 'good' : 'bad'); }

    // share
    const url = siteBase() + '/?ref=' + state.myRef;
    $('share-url').value = url;
    const msg = 'I keep all my WhatsApp group history in a free 200 GB vault on my own cloud. Get yours free (~35 min, guided): ' + url;
    $('wa-share').href = 'https://wa.me/?text=' + encodeURIComponent(msg);
    render.shareMsg = msg; render.shareUrl = url;
  }

  // ---------- quest flow ----------
  function openQuest(scroll) {
    $('quest').classList.remove('hidden');
    if (doneCount() === 7) $('win').classList.remove('hidden');
    if (scroll) $('quest').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function go(n) {
    state.current = Math.max(1, Math.min(7, n));
    save(); render();
    const li = document.querySelector(`.level[data-level="${state.current}"]`);
    if (li) setTimeout(() => li.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
  }
  function complete(n) {
    if (state.done[n]) return;
    state.done[n] = true;
    delete state.skipped[n];
    const l = LEVELS[n - 1];
    save();
    track('level_done', n);
    if (navigator.vibrate) navigator.vibrate(30);
    if (doneCount() === 7) {
      render(n);
      unlock();
      return;
    }
    toast(`+${l.xp} XP · ${l.badge} ${l.name} unlocked`);
    confetti(60, 0.55);
    const next = LEVELS.find((x) => x.n > n && !state.done[x.n]) || LEVELS.find((x) => !state.done[x.n]);
    state.current = next ? next.n : 7;
    save(); render(n);
    const li = document.querySelector(`.level[data-level="${state.current}"]`);
    if (li) setTimeout(() => li.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
  }
  function unlock() {
    $('win').classList.remove('hidden');
    track('unlocked');
    toast('🏆 Vault unlocked! +1000 XP club');
    confetti(220, 0.3);
    setTimeout(() => confetti(160, 0.2), 700);
    setTimeout(() => $('win').scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
  }

  // ---------- events ----------
  $('cta-main').onclick = () => {
    if (state.path !== 'oracle') { state.path = 'oracle'; track('start'); track('path_oracle'); }
    if (!state.done[state.current]) state.current = firstOpen();
    save(); render(); openQuest(true);
  };
  $$('.path').forEach((b) => {
    b.onclick = () => {
      const p = b.dataset.path;
      state.path = p; save(); track('path_' + p);
      if (p === 'oracle') { render(); openQuest(true); return; }
      location.href = p === 'home' ? 'home-setup.html' : 'cloud-setup.html';
    };
  });
  $$('.lv-head').forEach((h) => {
    h.onclick = () => go(Number(h.parentElement.dataset.level));
  });
  $('nav-back').onclick = () => go(state.current - 1);
  $('nav-skip').onclick = () => {
    state.skipped[state.current] = true;
    go(state.current + 1);
  };
  $('nav-done').onclick = () => {
    const n = state.current;
    if (state.done[n]) {
      if (doneCount() === 7) { $('win').classList.remove('hidden'); $('win').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      go(LEVELS.find((x) => x.n > n && !state.done[x.n])?.n || firstOpen());
      return;
    }
    if (!gateFor(n).ok) return;
    complete(n);
  };
  $('replay').onclick = () => go(1);

  $$('[data-field]').forEach((el) => {
    const f = el.dataset.field;
    if (state.data[f] != null) el.value = state.data[f];
    el.addEventListener('input', () => { state.data[f] = el.value.trim(); save(); render(); });
  });
  $$('[data-track]').forEach((a) => a.addEventListener('click', () => track('signup_click', 1)));
  $('console-link').addEventListener('click', () => track('console_click', 3));
  $('deploy').addEventListener('click', () => track('deploy_click', 6));

  // tabs
  $$('.tab').forEach((t) => {
    t.onclick = () => {
      $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
      $$('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab));
    };
  });

  // keygen
  let lastKey = null;
  $('keygen').onclick = async () => {
    const st = $('keygen-status');
    st.textContent = 'Generating…'; st.className = 'hint';
    try {
      const k = await window.EmbifiedSSH.generate({ comment: 'embified-vault' });
      lastKey = k;
      state.data.sshpub = k.publicKey;
      state.data.keyfile = k.filename;
      $('sshpub').value = k.publicKey;
      download(k.filename, k.privateKey);
      $('key-file').textContent = k.filename;
      $('key-saved').classList.remove('hidden');
      st.textContent = `✓ ${k.type === 'ed25519' ? 'Ed25519' : 'RSA-3072'} key created. Private key downloaded as “${k.filename}”.`;
      st.className = 'hint good';
      save(); render(); track('keygen', 5);
    } catch (e) {
      st.textContent = (e && e.message) || 'Key generation failed — use “I have my own”.';
      st.className = 'hint bad';
    }
  };
  $('key-redownload').onclick = () => { if (lastKey) download(lastKey.filename, lastKey.privateKey); else toast('Key lives only in memory — generate a new one'); };

  $('dl-tfvars').onclick = () => {
    const t = tfvars();
    $('tfvars-preview').textContent = t;
    $('tfvars-preview').classList.remove('hidden');
    download('terraform.tfvars', t);
    track('tfvars', 6);
  };

  $('pw').addEventListener('input', renderDynamic);
  $('pw-gen').onclick = () => { $('pw').value = rid(18); renderDynamic(); };
  $('copy-snippet').onclick = async () => { toast((await copy($('pw-snippet').textContent)) ? 'Commands copied' : 'Copy failed — select and copy manually'); };

  function markShared() {
    track('share');
    if (!state.shared) { state.shared = true; save(); render('share'); toast('📣 Ambassador badge unlocked'); confetti(50, 0.7); }
  }
  $('copy-share').onclick = async () => { if (await copy($('share-url').value)) { toast('Invite link copied'); markShared(); } };
  $('wa-share').addEventListener('click', markShared);
  if (navigator.share) {
    $('native-share').classList.remove('hidden');
    $('native-share').onclick = async () => {
      try { await navigator.share({ title: 'Embified vault', text: render.shareMsg, url: render.shareUrl }); markShared(); } catch { /* cancelled */ }
    };
  }
  $('reset').onclick = () => {
    if (!confirm('Reset your quest progress on this device?')) return;
    const keep = { cid: state.cid, myRef: state.myRef, ref: state.ref };
    try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* ignore */ }
    location.reload();
  };

  // ---------- boot ----------
  if (state.ref && !state.welcomed) { state.welcomed = true; save(); setTimeout(() => toast(`🎁 +${REF_BONUS} XP friend bonus`), 600); }
  render();
  if (state.path === 'oracle' || doneCount() > 0 || location.hash === '#quest') openQuest(location.hash === '#quest');
  track('view');
})();
