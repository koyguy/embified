import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Read-only team share links. A share exposes an explicit allow-list of groups to anyone holding
 * its link (/s/<token>). Only sha256(token) is stored; the token itself is shown once at creation.
 * Visiting the link sets a separate, HMAC-signed scoped cookie that names the share id; every request
 * re-reads the share, so revoking it cuts off the link and all existing scoped sessions immediately.
 * A share may also carry a password (scrypt hash only); then the link shows a password page first, and
 * the session is bound to the password state so setting/changing it signs everyone out.
 */
export interface Share {
  id: string;
  label: string;
  groupIds: string[];
  created: string;
  revoked: string | null;
  tokenHash: string;
  /** Optional second factor: `scrypt$N$r$p$salt$hash` (base64url). Absent/null = link alone opens the share. */
  passwordHash?: string | null;
  passwordSet?: string | null;
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

export function createShare(opts: { label: string; groupIds: string[]; tokenHash?: string; passwordHash?: string | null }) {
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
    ...(opts.passwordHash ? { passwordHash: opts.passwordHash, passwordSet: new Date().toISOString() } : {}),
  };
  shares.push(share);
  saveShares(shares);
  return { share, token };
}

function updateShare(id: string, fn: (s: Share) => void) {
  const shares = loadShares().map((s) => ({ ...s }));
  const s = shares.find((x) => x.id === id);
  if (!s) throw new Error(`no share with id ${id}`);
  fn(s);
  saveShares(shares);
  return s;
}

/* ---------- optional per-share password (node scrypt) ---------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
export const MIN_SHARE_PASSWORD = 8;

function scryptAsync(pw: string, salt: Buffer, N: number, r: number, p: number, keylen: number) {
  return new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(pw.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

export async function hashSharePassword(pw: string) {
  const s = String(pw ?? '');
  if (s.length < MIN_SHARE_PASSWORD) throw new Error(`password must be at least ${MIN_SHARE_PASSWORD} characters`);
  if (s.length > 256) throw new Error('password is too long');
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(s, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time check against a stored scrypt hash; malformed hashes never match (fail closed). */
export async function verifySharePassword(pw: string, stored?: string | null) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || N > 1 << 17 || r > 32 || p > 4) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const want = Buffer.from(parts[5], 'base64url');
  if (salt.length < 8 || want.length < 16) return false;
  const s = String(pw ?? '');
  if (!s || s.length > 256) return false;
  const got = await scryptAsync(s, salt, N, r, p, want.length);
  return crypto.timingSafeEqual(got, want);
}

/** Human-friendly random password: three words + two digits, e.g. "maple-river-orbit-42" (~33 bits, CSPRNG). */
const WORDS = (
  'acorn amber anchor apple arrow aspen atlas autumn badge bamboo banjo barley basil beacon berry birch biscuit ' +
  'blossom bonfire breeze brick bridge brook bubble cabin cactus camel candle canyon carbon cedar cello chalk ' +
  'cherry cider cinder citrus clover cobalt comet copper coral cotton crane crayon cricket crystal cypress daisy ' +
  'delta denim desert dolphin dragon drift eagle ember falcon fennel fern fiddle fig flint forest fossil fox ' +
  'galaxy garden garnet ginger glacier globe granite grape gravel harbor hazel heron hickory honey horizon ' +
  'indigo iris island ivory jasmine jungle juniper kayak kettle kiwi lagoon lantern lava lemon lilac lily lotus ' +
  'magnet mango maple marble meadow melon meteor mint mirror monsoon moss nectar nickel nutmeg oasis ocean olive ' +
  'onyx orbit orchid otter owl paddle palm panda papaya pearl pebble pepper piano pilot pine planet plum pollen ' +
  'pony prism pumpkin quartz quill rabbit radish rain raven reef ribbon river robin rocket rose ruby saffron sage ' +
  'salmon sand sapphire satin scarlet shadow shell sierra silver sky slate snow sparrow spice spruce squirrel ' +
  'star stone storm summit sunset swan tango teal thistle thunder tiger timber topaz tulip tundra turtle ' +
  'valley velvet violet walnut willow window winter wren yarrow zebra zephyr'
).split(/\s+/);
export function generateSharePassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${crypto.randomInt(10, 100)}`;
}

export function shareHasPassword(share: Share) {
  return Boolean(share.passwordHash);
}

/**
 * Session binding for the password state: any set/change/clear yields a new tag (fresh salt), so every
 * session issued before it stops verifying and teammates must open the link (and enter the password) again.
 */
export function passwordTag(share: Share) {
  return share.passwordHash ? crypto.createHash('sha256').update(share.passwordHash).digest('hex').slice(0, 12) : '-';
}

export async function setSharePassword(id: string, password: string) {
  if (!loadShares().some((x) => x.id === id)) throw new Error(`no share with id ${id}`);
  const passwordHash = await hashSharePassword(password);
  return updateShare(id, (s) => {
    s.passwordHash = passwordHash;
    s.passwordSet = new Date().toISOString();
  });
}

export function clearSharePassword(id: string) {
  return updateShare(id, (s) => {
    s.passwordHash = null;
    s.passwordSet = new Date().toISOString();
  });
}

export function revokeShare(id: string) {
  return updateShare(id, (s) => {
    if (!s.revoked) s.revoked = new Date().toISOString();
  });
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
  // Bind to the token hash prefix (re-issuing under a new token invalidates old sessions) and to the
  // password state (setting/changing a password invalidates sessions opened before it).
  const payload = `s2.${share.id}.${share.tokenHash.slice(0, 16)}.${passwordTag(share)}.${exp}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Valid signature + not expired + share still active + same password state → the share; else null. */
export function verifyShareSession(value?: string, now = Date.now()): Share | null {
  if (!value) return null;
  const parts = value.split('.');
  // s1 = pre-password sessions (no password tag): only honoured while the share has no password.
  const v1 = parts.length === 5 && parts[0] === 's1';
  const v2 = parts.length === 6 && parts[0] === 's2';
  if (!v1 && !v2) return null;
  const payload = parts.slice(0, -1).join('.');
  const expect = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(parts[parts.length - 1]);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const exp = Number(parts[parts.length - 2]);
  if (!Number.isFinite(exp) || exp <= now) return null;
  const share = getActiveShare(parts[1]);
  if (!share || share.tokenHash.slice(0, 16) !== parts[2]) return null;
  const tag = v1 ? '-' : parts[3];
  if (tag !== passwordTag(share)) return null;
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
