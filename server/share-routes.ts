import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import path from 'path';
import * as store from './store.ts';
import { getAuth, type AuthContext } from './auth.ts';
import {
  clearShareCookie,
  findShareByToken,
  getActiveShare,
  shareCookieValue,
  signShareSession,
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
  res.setHeader('Cache-Control', 'no-store');
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

/** /s/<token>: exchange the link for a scoped session cookie, then open the inbox. Mount before requireAuth. */
export function registerShareLink(app: Express) {
  app.get('/s/:token', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const share = findShareByToken(String(req.params.token || ''));
    if (!share) {
      res.setHeader('Set-Cookie', clearShareCookie(req.secure));
      res.status(404).type('html').send(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not available</title>' +
          '<body style="font-family:system-ui;background:#0b141a;color:#e9edef;display:grid;place-items:center;height:100vh;margin:0">' +
          '<div style="text-align:center;padding:24px"><h1 style="font-size:20px">This share link is not available</h1>' +
          '<p style="color:#8696a0">It may have been revoked. Ask the owner for a new link.</p></div></body>'
      );
      return;
    }
    res.setHeader('Set-Cookie', shareCookieValue(signShareSession(share), req.secure));
    res.redirect(302, '/');
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
  return getActiveShare(share.id)?.tokenHash === share.tokenHash;
}
