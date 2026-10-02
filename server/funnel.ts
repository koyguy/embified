import fs from 'fs';
import path from 'path';

/**
 * Anonymous onboarding-funnel analytics for /start.
 * Stores only: event name, optional level number, timestamp, random client id, optional ref code.
 * No IPs, no user agents, no secrets. One JSON object per line in DATA_DIR/funnel-events.jsonl.
 */

export const FUNNEL_EVENTS = new Set([
  'view',
  'start',
  'path_oracle',
  'path_home',
  'path_cloud',
  'level_done',
  'signup_click',
  'console_click',
  'keygen',
  'tfvars',
  'deploy_click',
  'unlocked',
  'share',
]);

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const REF_RE = /^[A-Za-z0-9_-]{1,32}$/;

export type FunnelEvent = {
  t: string;
  e: string;
  cid: string;
  lvl?: number;
  ref?: string;
};

export function funnelFile() {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dir, 'funnel-events.jsonl');
}

export function sanitizeEvent(body: any, now = new Date()): FunnelEvent | null {
  if (!body || typeof body !== 'object') return null;
  const e = String(body.event ?? body.e ?? '');
  const cid = String(body.cid ?? '');
  if (!FUNNEL_EVENTS.has(e) || !ID_RE.test(cid)) return null;
  const out: FunnelEvent = { t: now.toISOString(), e, cid };
  const lvl = Number(body.level ?? body.lvl);
  if (Number.isInteger(lvl) && lvl >= 1 && lvl <= 7) out.lvl = lvl;
  if (typeof body.ref === 'string' && REF_RE.test(body.ref)) out.ref = body.ref;
  return out;
}

// Very light per-IP rate limit (IP is never persisted).
const buckets = new Map<string, { n: number; reset: number }>();
export function allowRate(key: string, limit = 60, windowMs = 60_000, now = Date.now()) {
  const b = buckets.get(key);
  if (!b || b.reset <= now) {
    if (buckets.size > 5000) buckets.clear();
    buckets.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  b.n += 1;
  return b.n <= limit;
}

export function appendEvent(ev: FunnelEvent, file = funnelFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(ev) + '\n');
}

export function aggregate(lines: string[]) {
  const events: Record<string, number> = {};
  const uniq: Record<string, Set<string>> = {};
  const levels: Record<string, Set<string>> = {};
  const refs: Record<string, Set<string>> = {};
  const clients = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: FunnelEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev.e !== 'string' || typeof ev.cid !== 'string') continue;
    clients.add(ev.cid);
    events[ev.e] = (events[ev.e] || 0) + 1;
    (uniq[ev.e] ||= new Set()).add(ev.cid);
    if (ev.e === 'level_done' && ev.lvl) (levels[String(ev.lvl)] ||= new Set()).add(ev.cid);
    if (ev.ref) (refs[ev.ref] ||= new Set()).add(ev.cid);
  }
  const toCounts = (m: Record<string, Set<string>>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.size]));
  return {
    uniqueClients: clients.size,
    events,
    uniqueByEvent: toCounts(uniq),
    levelsCompleted: toCounts(levels),
    referrals: toCounts(refs),
  };
}

export function readStats(file = funnelFile()) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* no events yet */
  }
  return { ok: true, generatedAt: new Date().toISOString(), ...aggregate(text.split('\n')) };
}
