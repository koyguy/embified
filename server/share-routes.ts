import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import path from 'path';
import * as store from './store.ts';
import { getAuth, parseCookies, type AuthContext } from './auth.ts';
import { isLoopback } from './tunnel.ts';
import {
  SHARE_COOKIE,
  clearShareCookie,
  findShareByToken,
  getActiveShare,
  passwordTag,
  shareCookieValue,
  shareHasPassword,
  signShareSession,
  verifySharePassword,
  verifyShareSession,
  type Share,
} from './shares.ts';
import type { ChatMessage, GroupSummary } from '../src/types.ts';

/**
 * Routes shared by the owner inbox and read-only team shares, plus the scope guard.
 * Default-deny for shared sessions: only the paths listed in shareScopeGuard are reachable,
 * and group/media access is re-checked against the share's allow-list on every request.
 */

const NOT_FOUND = { error: 'not found' };

export function shareOf(req: Request): Share | null {
  const a = getAuth(req);
  return a && a.role === 'share' ? a.share : null;
}

export function canReadGroup(ctx: AuthContext | null, groupId: string) {
  if (!ctx) return false;
  if (ctx.role === 'owner') return true;
  return ctx.share.groupIds.includes(groupId);
}

/** Group summary safe for a shared view: no participant lists, no owner unread counters. */
export function publicGroup(g: GroupSummary & { participants?: unknown }): GroupSummary {
  return {
    id: g.id,
    name: g.name,
    memberCount: g.memberCount,
    lastMessage: g.lastMessage,
    lastAt: g.lastAt,
    unread: 0,
    messageCount: g.messageCount,
    kind: g.kind,
  };
}

export function groupsFor(ctx: AuthContext | null): GroupSummary[] {
  const all = store.listGroups();
  if (!ctx) return [];
  if (ctx.role === 'owner') return all;
  return all.filter((g) => ctx.share.groupIds.includes(g.id)).map(publicGroup);
}

/** Media file names (as stored under /media/) referenced by a share's groups, cached per group state. */
const mediaCache = new Map<string, { key: string; files: Set<string> }>();
function mediaFilesForGroup(groupId: string, stateKey: string) {
  const hit = mediaCache.get(groupId);
  if (hit && hit.key === stateKey) return hit.files;
  const files = new Set<string>();
  for (const m of store.loadMessages(groupId)) {
    for (const att of m.media || []) {
      if (typeof att.url === 'string' && att.url.startsWith('/media/')) files.add(att.url.slice('/media/'.length));
    }
  }
  mediaCache.set(groupId, { key: stateKey, files });
  return files;
}

export function shareCanReadMedia(share: Share, fileName: string) {
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.startsWith('.')) return false;
  const groups = new Map(store.listGroups().map((g) => [g.id, g]));
  for (const id of share.groupIds) {
    const g = groups.get(id);
    if (!g) continue;
    if (mediaFilesForGroup(id, `${g.messageCount}|${g.lastAt}`).has(fileName)) return true;
  }
  // Media attached after the summary was written (background history downloads) → rescan once uncached.
  for (const id of share.groupIds) {
    mediaCache.delete(id);
    const g = groups.get(id);
    if (g && mediaFilesForGroup(id, `${g.messageCount}|${g.lastAt}`).has(fileName)) return true;
  }
  return false;
}

const MESSAGES_RE = /^\/api\/groups\/([^/]+)\/messages$/;

function decodeSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Mount right after requireAuth. Owner requests pass untouched. Shared sessions may only:
 *   GET /api/share/me, GET /api/groups, GET /api/groups/<allowed>/messages, GET /api/events,
 *   GET /media/<file of an allowed group>, and the SPA shell (non-/api, non-/media GETs).
 * Everything else → 403 (owner-only) or 404 (other groups / media).
 */
export function shareScopeGuard(req: Request, res: Response, next: NextFunction) {
  const share = shareOf(req);
  if (!share) return next();
  if (req.path !== '/api/events') res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(403).json({ error: 'read-only shared view' });
    return;
  }
  const p = req.path;
  if (p.startsWith('/media/') || p === '/media') {
    const name = decodeSafe(p.slice('/media/'.length));
    if (name && shareCanReadMedia(share, path.basename(name)) && path.basename(name) === name) return next();
    res.status(404).json(NOT_FOUND);
    return;
  }
  if (p.startsWith('/api/')) {
    if (p === '/api/share/me' || p === '/api/groups' || p === '/api/events') return next();
    const m = MESSAGES_RE.exec(p);
    if (m) {
      const id = decodeSafe(m[1]);
      if (id && share.groupIds.includes(id)) return next();
      res.status(404).json(NOT_FOUND);
      return;
    }
    res.status(403).json({ error: 'not available in a shared view' });
    return;
  }
  // /health, /api/digest/health etc. are public and handled before this guard. Remaining GETs are the SPA.
  return next();
}

/* ---------- password attempts: per share + client IP, exponential backoff ---------- */

const FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
const FORGET_MS = 60 * 60_000;
type Attempt = { fails: number; lockedUntil: number; last: number };
const attempts = new Map<string, Attempt>();

/** Tunnel requests arrive from cloudflared on loopback: use Cloudflare's client IP header there only. */
export function clientIp(req: Request) {
  const remote = req.socket?.remoteAddress || '';
  const cf = req.headers['cf-connecting-ip'];
  if (isLoopback(remote) && typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
  return String(req.ip || remote || '?');
}

function attemptKey(share: Share, ip: string) {
  return `${share.id}|${ip}`;
}

/** ms until this share+IP may try again (0 = allowed now). */
export function lockRemaining(share: Share, ip: string, now = Date.now()) {
  const a = attempts.get(attemptKey(share, ip));
  return a && a.lockedUntil > now ? a.lockedUntil - now : 0;
}

export function recordFailure(share: Share, ip: string, now = Date.now()) {
  const key = attemptKey(share, ip);
  const prev = attempts.get(key);
  const a: Attempt = prev && now - prev.last < FORGET_MS ? prev : { fails: 0, lockedUntil: 0, last: now };
  a.fails += 1;
  a.last = now;
  if (a.fails >= FREE_ATTEMPTS) {
    a.lockedUntil = now + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (a.fails - FREE_ATTEMPTS));
  }
  attempts.set(key, a);
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) if (now - v.last > FORGET_MS) attempts.delete(k);
  }
  return a;
}

export function resetAttempts() {
  attempts.clear();
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Same look as public/login.html. Posts back to the current URL (action=""), so the token is not in the HTML. */
export function sharePasswordPage(label: string, error = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<title>Embified — Shared groups</title>
<style>
:root { color-scheme: dark; --bg:#0b1410; --card:#122018; --ink:#e8f5ee; --muted:#8aa897; --accent:#25d366; --line:#1e3328; --danger:#ff6b6b; }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; font-family: Inter, system-ui, sans-serif; background: radial-gradient(900px 500px at 20% -10%, #163528, transparent), var(--bg); color: var(--ink); }
.card { width:min(400px, 92vw); background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px 24px; }
h1 { font-size:1.35rem; margin:0 0 8px; }
p { color:var(--muted); margin:0 0 20px; font-size:0.95rem; line-height:1.45; }
.tag { display:inline-block; font-size:0.8rem; padding:3px 10px; border-radius:999px; background:#10281c; border:1px solid #1f6b3f; color:var(--accent); margin-bottom:14px; }
label { display:block; font-size:0.85rem; margin-bottom:6px; color:var(--muted); }
input[type=password], input[type=text] { width:100%; padding:12px 14px; border-radius:10px; border:1px solid var(--line); background:#0a1611; color:var(--ink); font-size:1rem; }
button { margin-top:14px; width:100%; padding:12px; border:0; border-radius:10px; background:var(--accent); color:#06210f; font-weight:700; font-size:1rem; cursor:pointer; }
.show { display:flex; gap:8px; align-items:center; margin-top:10px; font-size:0.85rem; color:var(--muted); }
.err { color:var(--danger); font-size:0.9rem; margin:10px 0 0; min-height:1.2em; }
</style></head>
<body>
<form class="card" method="post" action="" autocomplete="off">
<span class="tag">Shared view · read-only</span>
<h1>${esc(label || 'Shared groups')}</h1>
<p>These WhatsApp groups are password protected. Enter the password you were given to continue.</p>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus />
<label class="show"><input type="checkbox" onclick="document.getElementById('password').type=this.checked?'text':'password'" /> Show password</label>
<button type="submit">Open groups</button>
<p class="err" id="err" role="alert">${esc(error)}</p>
</form>
</body></html>`;
}

function shareHeaders(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Frame-Options', 'DENY');
}

function notAvailable(req: Request, res: Response) {
  res.setHeader('Set-Cookie', clearShareCookie(req.secure));
  res.status(404).type('html').send(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not available</title>' +
      '<body style="font-family:system-ui;background:#0b141a;color:#e9edef;display:grid;place-items:center;height:100vh;margin:0">' +
      '<div style="text-align:center;padding:24px"><h1 style="font-size:20px">This share link is not available</h1>' +
      '<p style="color:#8696a0">It may have been revoked. Ask the owner for a new link.</p></div></body>'
  );
}

function grant(req: Request, res: Response, share: Share) {
  res.setHeader('Set-Cookie', shareCookieValue(signShareSession(share), req.secure));
  res.redirect(req.method === 'POST' ? 303 : 302, '/');
}

function waitText(ms: number) {
  const s = Math.ceil(ms / 1000);
  return s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`;
}

/**
 * /s/<token>: exchange the link for a scoped session cookie, then open the inbox. Mount before requireAuth
 * and after express.urlencoded. A share with a password shows a password page first (POST back to the same URL).
 */
export function registerShareLink(app: Express) {
  app.get('/s/:token', (req, res) => {
    shareHeaders(res);
    const share = findShareByToken(String(req.params.token || ''));
    if (!share) return notAvailable(req, res);
    if (!shareHasPassword(share)) return grant(req, res, share);
    // Already unlocked in this browser (same share, current password) → straight in.
    const current = verifyShareSession(parseCookies(req.headers.cookie)[SHARE_COOKIE]);
    if (current && current.id === share.id) {
      res.redirect(302, '/');
      return;
    }
    res.status(200).type('html').send(sharePasswordPage(share.label));
  });

  app.post('/s/:token', async (req, res) => {
    shareHeaders(res);
    const share = findShareByToken(String(req.params.token || ''));
    if (!share) return notAvailable(req, res);
    if (!shareHasPassword(share)) return grant(req, res, share);
    const ip = clientIp(req);
    const wait = lockRemaining(share, ip);
    if (wait > 0) {
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      res.status(429).type('html').send(sharePasswordPage(share.label, `Too many wrong attempts. Try again in ${waitText(wait)}.`));
      return;
    }
    const pw = typeof req.body?.password === 'string' ? req.body.password : '';
    let ok = false;
    try {
      ok = await verifySharePassword(pw, share.passwordHash);
    } catch {
      ok = false;
    }
    // Re-read: the password may have changed while scrypt ran.
    const fresh = getActiveShare(share.id);
    if (ok && fresh && fresh.passwordHash === share.passwordHash) {
      attempts.delete(attemptKey(share, ip));
      return grant(req, res, fresh);
    }
    const a = recordFailure(share, ip);
    const left = Math.max(0, FREE_ATTEMPTS - a.fails);
    const msg = a.lockedUntil > Date.now()
      ? `Wrong password. Too many attempts — try again in ${waitText(a.lockedUntil - Date.now())}.`
      : `Wrong password. ${left} attempt${left === 1 ? '' : 's'} left before a short wait.`;
    res.status(401).type('html').send(sharePasswordPage(share.label, msg));
  });
}

/** Group list, messages, media and the share descriptor (owner + scoped). Mount after shareScopeGuard. */
export function registerInboxRoutes(app: Express) {
  app.use('/media', express.static(store.getMediaDir(), { maxAge: '7d', index: false, dotfiles: 'deny' }));

  app.get('/api/share/me', (req, res) => {
    const a = getAuth(req);
    if (a?.role === 'share') {
      res.json({ role: 'share', id: a.share.id, label: a.share.label, readOnly: true });
      return;
    }
    res.json({ role: 'owner' });
  });

  app.get('/api/groups', (req, res) => {
    res.json({ groups: groupsFor(getAuth(req)) });
  });

  app.get('/api/groups/:id/messages', (req, res) => {
    const ctx = getAuth(req);
    const id = decodeURIComponent(req.params.id);
    if (!canReadGroup(ctx, id)) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    const messages: ChatMessage[] = store.loadMessages(id);
    // A teammate reading must not clear the owner's unread badge.
    if (ctx?.role === 'owner') store.markRead(id);
    res.json({ messages });
  });

  app.post('/api/groups/:id/read', (req, res) => {
    if (getAuth(req)?.role !== 'owner') {
      res.status(403).json({ error: 'read-only shared view' });
      return;
    }
    store.markRead(decodeURIComponent(req.params.id));
    res.json({ ok: true, groups: store.listGroups() });
  });
}

/** Server-sent events filtered for a share; returns false when the share was revoked meanwhile. */
export function shareStillActive(share: Share) {
  const cur = getActiveShare(share.id);
  return Boolean(cur && cur.tokenHash === share.tokenHash && passwordTag(cur) === passwordTag(share));
}
