import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

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

export function sessionCookieValue(token: string) {
  const secure = process.env.EMBIFIED_AUTH_SECURE === '1' || process.env.EMBIFIED_AUTH_SECURE === 'true';
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

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isPublicPath(p: string) {
  if (p === '/health' || p === '/login' || p === '/vault' || p === '/create-vault' || p === '/cloud-setup' || p === '/home-setup') return true;
  if (p.startsWith('/public/')) return true;
  if (p.startsWith('/auth/')) return true;
  if (p.startsWith('/api/whatsapp/webhook')) return true;
  return false;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled()) return next();
  if (isPublicPath(req.path)) return next();
  const cookies = parseCookies(req.headers.cookie);
  if (verifySession(cookies[SESSION_COOKIE])) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/media')) {
    res.status(401).json({ error: 'unauthorized', login: '/login' });
    return;
  }
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  res.redirect(`/login?next=${nextUrl}`);
}
