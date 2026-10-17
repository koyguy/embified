import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { SHARE_COOKIE, verifyShareSession, type Share } from './shares.ts';

export const SESSION_COOKIE = 'embified_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function authEnabled() {
  return Boolean(process.env.EMBIFIED_AUTH_PASSWORD && process.env.EMBIFIED_AUTH_PASSWORD.length > 0);
}

function secret() {
  return (
    process.env.EMBIFIED_AUTH_SECRET ||
    process.env.EMBIFIED_AUTH_PASSWORD ||
    'embified-dev-secret'
  );
}

export function signSession() {
  const exp = String(Date.now() + MAX_AGE_MS);
  const payload = `v1.${exp}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token?: string) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const sig = parts[2];
  const expect = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  const exp = Number(parts[1]);
  return Number.isFinite(exp) && exp > Date.now();
}

export function checkPassword(pw: string) {
  const want = process.env.EMBIFIED_AUTH_PASSWORD || '';
  const a = Buffer.from(String(pw ?? ''), 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length) {
    const pad = Buffer.alloc(Math.max(b.length, 1));
    a.copy(pad);
    try {
      crypto.timingSafeEqual(pad.subarray(0, b.length || 1), b.length ? b : Buffer.from('x'));
    } catch {
      /* ignore */
    }
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function parseCookies(header?: string) {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function forceSecure() {
  return process.env.EMBIFIED_AUTH_SECURE === '1' || process.env.EMBIFIED_AUTH_SECURE === 'true';
}

/** `secure` = request arrived over https (e.g. through the Cloudflare tunnel); plain local http keeps working. */
export function sessionCookieValue(token: string, secureRequest = false) {
  const secure = forceSecure() || secureRequest;
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secureRequest = false) {
  const base = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return forceSecure() || secureRequest ? `${base}; Secure` : base;
}

export function isPublicPath(p: string) {
  // Marketing pages (/start, /vault, …) are 301s registered before the auth wall (server/public-site.ts).
  if (p === '/health' || p === '/login') return true;
  // Minimal link-state for external monitors (no message data, no phone number).
  if (p === '/api/digest/health') return true;
  if (p.startsWith('/public/')) return true;
  if (p.startsWith('/auth/')) return true;
  // Team share links (/s/<token>) are their own credential; see server/share-routes.ts.
  if (p.startsWith('/s/')) return true;
  if (p.startsWith('/api/whatsapp/webhook')) return true;
  return false;
}

export type AuthContext = { role: 'owner' } | { role: 'share'; share: Share };

/** Owner session wins; otherwise a live (non-revoked) team-share session; otherwise none. */
export function authContext(req: Request): AuthContext | null {
  if (!authEnabled()) return { role: 'owner' };
  const cookies = parseCookies(req.headers.cookie);
  if (verifySession(cookies[SESSION_COOKIE])) return { role: 'owner' };
  const share = verifyShareSession(cookies[SHARE_COOKIE]);
  if (share) return { role: 'share', share };
  return null;
}

export function getAuth(req: Request): AuthContext | null {
  return ((req as any).embAuth as AuthContext | undefined) ?? null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isPublicPath(req.path)) return next();
  const ctx = authContext(req);
  if (ctx) {
    (req as any).embAuth = ctx;
    return next();
  }
  if (req.path.startsWith('/api/') || req.path.startsWith('/media')) {
    res.status(401).json({ error: 'unauthorized', login: '/login' });
    return;
  }
  // A teammate whose shared session ended (password set/changed, revoked, expired) should not land on the owner login.
  if (parseCookies(req.headers.cookie)[SHARE_COOKIE]) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', `${SHARE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${forceSecure() || req.secure ? '; Secure' : ''}`);
    res.status(401).type('html').send(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared view ended</title>' +
        '<body style="font-family:system-ui;background:#0b141a;color:#e9edef;display:grid;place-items:center;height:100vh;margin:0">' +
        '<div style="text-align:center;padding:24px"><h1 style="font-size:20px">Your shared view has ended</h1>' +
        '<p style="color:#8696a0">Open the share link you were given again. It may now ask for a password.</p></div></body>'
    );
    return;
  }
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  res.redirect(`/login?next=${nextUrl}`);
}
