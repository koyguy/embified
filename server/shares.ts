import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Read-only team share links. A share exposes an explicit allow-list of groups to anyone holding
 * its link (/s/<token>). Only sha256(token) is stored; the token itself is shown once at creation.
 * Visiting the link sets a separate, HMAC-signed scoped cookie that names the share id; every request
 * re-reads the share, so revoking it cuts off the link and all existing scoped sessions immediately.
 */
export interface Share {
  id: string;
  label: string;
  groupIds: string[];
  created: string;
  revoked: string | null;
  tokenHash: string;
}

export const SHARE_COOKIE = 'embified_share';
const SHARE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function dataDir(env: NodeJS.ProcessEnv = process.env) {
  return env.DATA_DIR || path.join(process.cwd(), 'data');
}

export function sharesFile(env: NodeJS.ProcessEnv = process.env) {
  return path.join(dataDir(env), 'shares.json');
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** 256-bit url-safe token. */
export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
export function looksLikeToken(t: string) {
  return TOKEN_RE.test(t);
}

let cache: { file: string; mtimeMs: number; size: number; shares: Share[] } | null = null;

export function loadShares(): Share[] {
  const file = sharesFile();
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache = null;
    return [];
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.shares;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const shares: Share[] = Array.isArray(raw?.shares) ? raw.shares : [];
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, shares };
    return shares;
  } catch {
    // Unreadable file = no shares (fail closed).
    return [];
  }
}

function saveShares(shares: Share[]) {
  const file = sharesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, shares }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = null;
}

export function createShare(opts: { label: string; groupIds: string[]; tokenHash?: string }) {
  const label = String(opts.label || '').trim().slice(0, 80);
  if (!label) throw new Error('label is required');
  const groupIds = [...new Set(opts.groupIds.map((g) => String(g).trim()).filter(Boolean))];
  if (!groupIds.length) throw new Error('at least one --group is required');
  for (const g of groupIds) {
    if (!/^[A-Za-z0-9@._:-]{3,128}$/.test(g)) throw new Error(`invalid group id: ${g}`);
  }
  let token: string | null = null;
  let tokenHash = opts.tokenHash?.trim().toLowerCase();
  if (tokenHash) {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('token hash must be 64 hex chars (sha256)');
  } else {
    token = newToken();
    tokenHash = hashToken(token);
  }
  const shares = loadShares().slice();
  if (shares.some((s) => s.tokenHash === tokenHash)) throw new Error('token already in use');
  const share: Share = {
    id: `sh_${crypto.randomBytes(6).toString('hex')}`,
    label,
    groupIds,
    created: new Date().toISOString(),
    revoked: null,
    tokenHash,
  };
  shares.push(share);
  saveShares(shares);
  return { share, token };
}

export function revokeShare(id: string) {
  const shares = loadShares().map((s) => ({ ...s }));
  const s = shares.find((x) => x.id === id);
  if (!s) throw new Error(`no share with id ${id}`);
  if (!s.revoked) s.revoked = new Date().toISOString();
  saveShares(shares);
  return s;
}

export function getActiveShare(id: string): Share | null {
  const s = loadShares().find((x) => x.id === id);
  return s && !s.revoked ? s : null;
}

export function findShareByToken(token: string): Share | null {
  if (!looksLikeToken(token)) return null;
  const h = Buffer.from(hashToken(token), 'hex');
  for (const s of loadShares()) {
    if (s.revoked) continue;
    const b = Buffer.from(s.tokenHash, 'hex');
    if (b.length === h.length && crypto.timingSafeEqual(b, h)) return s;
  }
  return null;
}

/* ---------- scoped session cookie ---------- */

function secret() {
  const base = process.env.EMBIFIED_AUTH_SECRET || process.env.EMBIFIED_AUTH_PASSWORD || 'embified-dev-secret';
  // Domain-separated from the owner session key so an owner token can never parse as a share token.
  return crypto.createHmac('sha256', base).update('embified-share-session-v1').digest();
}

export function signShareSession(share: Share, now = Date.now()) {
  const exp = String(now + SHARE_MAX_AGE_MS);
  // Bind to the token hash prefix too: re-issuing a share under a new token invalidates old sessions.
  const payload = `s1.${share.id}.${share.tokenHash.slice(0, 16)}.${exp}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Valid signature + not expired + share still active → the share; anything else → null. */
export function verifyShareSession(value?: string, now = Date.now()): Share | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== 's1') return null;
  const payload = parts.slice(0, 4).join('.');
  const expect = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(parts[4]);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const exp = Number(parts[3]);
  if (!Number.isFinite(exp) || exp <= now) return null;
  const share = getActiveShare(parts[1]);
  if (!share || share.tokenHash.slice(0, 16) !== parts[2]) return null;
  return share;
}

function forceSecure() {
  return process.env.EMBIFIED_AUTH_SECURE === '1' || process.env.EMBIFIED_AUTH_SECURE === 'true';
}

export function shareCookieValue(value: string, secureRequest = false) {
  const parts = [
    `${SHARE_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SHARE_MAX_AGE_MS / 1000)}`,
  ];
  if (forceSecure() || secureRequest) parts.push('Secure');
  return parts.join('; ');
}

export function clearShareCookie(secureRequest = false) {
  const base = `${SHARE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return forceSecure() || secureRequest ? `${base}; Secure` : base;
}

/** For any request logging: never write a share token in plaintext. */
export function redactSharePath(url: string) {
  return String(url || '').replace(/\/s\/[^/?#\s]+/g, '/s/[redacted]');
}
