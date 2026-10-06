import fs from 'fs';
import type { Express, NextFunction, Request, Response } from 'express';

/**
 * HTTPS for a vault without a domain: cloudflared runs a quick tunnel
 * (embified-tunnel.service, scripts/cloud-api-https/) and writes the assigned
 * https://*.trycloudflare.com origin to TUNNEL_URL_FILE. The app:
 *   - trusts loopback proxies, so tunnel requests (cloudflared → 127.0.0.1, X-Forwarded-Proto: https)
 *     count as secure and get a `Secure` session cookie;
 *   - redirects plain-http requests that reach the public IP to the same path on the current
 *     https origin, so http://<ip>/ always forwards to wherever the tunnel lives now.
 * EMBIFIED_PUBLIC_URL pins a stable origin instead (named tunnel / custom domain).
 */
export const DEFAULT_TUNNEL_URL_FILE = '/var/lib/embified/tunnel-url.txt';

/** Monitors, webhooks, static login assets and marketing 301s keep answering over plain http. */
const HTTP_EXEMPT_EXACT = new Set(['/health', '/api/digest/health']);
const HTTP_EXEMPT_PREFIX = ['/api/whatsapp/webhook', '/public/'];

/** Accept only a bare https origin (no path, query, credentials or odd characters). */
export function normalizeOrigin(raw: unknown): string | null {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/.test(s)) return null;
  return s.toLowerCase();
}

let cache: { file: string; at: number; value: string | null } | null = null;
const CACHE_MS = 2000;

/** Current public https origin: EMBIFIED_PUBLIC_URL, else the quick-tunnel URL file, else null. */
export function publicHttpsUrl(env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | null {
  const pinned = normalizeOrigin(env.EMBIFIED_PUBLIC_URL);
  if (pinned) return pinned;
  const file = env.EMBIFIED_TUNNEL_URL_FILE || DEFAULT_TUNNEL_URL_FILE;
  if (cache && cache.file === file && now - cache.at < CACHE_MS) return cache.value;
  let value: string | null = null;
  try {
    value = normalizeOrigin(fs.readFileSync(file, 'utf8').split('\n')[0]);
  } catch {
    value = null;
  }
  cache = { file, at: now, value };
  return value;
}

export function resetTunnelCache() {
  cache = null;
}

export function isLoopback(addr?: string | null) {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\./.test(a);
}

export function isHttpExempt(p: string) {
  if (HTTP_EXEMPT_EXACT.has(p)) return true;
  return HTTP_EXEMPT_PREFIX.some((x) => p.startsWith(x));
}

/** Trust X-Forwarded-* only from loopback (cloudflared on the same host). Override with EMBIFIED_TRUST_PROXY. */
export function configureProxyTrust(app: Express, env: NodeJS.ProcessEnv = process.env) {
  app.set('trust proxy', env.EMBIFIED_TRUST_PROXY || 'loopback');
}

/**
 * Plain-http request from outside the box + known https origin → 302/307 to the same path there.
 * Tunnel traffic arrives from loopback with X-Forwarded-Proto: https (req.secure), so it never loops.
 */
export function httpsRedirect(skip: (p: string) => boolean = () => false) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.secure) return next();
    if (isLoopback(req.socket?.remoteAddress)) return next();
    if (isHttpExempt(req.path) || skip(req.path)) return next();
    const target = publicHttpsUrl();
    if (!target) return next();
    const url = req.originalUrl && req.originalUrl.startsWith('/') ? req.originalUrl : '/';
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 302 : 307, `${target}${url}`);
  };
}
