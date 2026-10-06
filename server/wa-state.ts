import fs from 'fs';
import path from 'path';
import type { WaLinkState } from '../src/types.ts';

/**
 * Persisted linked-device state so monitors (GET /api/digest/health) can see "logged_out since X"
 * even across restarts. `since` only changes when the state actually changes.
 */
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'whatsapp-state.json');

export interface WaStateRecord {
  state: WaLinkState;
  since: string;
  detail?: string | null;
  updatedAt: string;
  lastConnectedAt?: string | null;
  lastLoggedOutAt?: string | null;
}

let cache: WaStateRecord | null = null;

export function readWaState(): WaStateRecord | null {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = null;
  }
  return cache;
}

export function recordWaState(state: WaLinkState, detail?: string | null, now = new Date()): WaStateRecord {
  const prev = readWaState();
  const iso = now.toISOString();
  const next: WaStateRecord = {
    state,
    since: prev && prev.state === state ? prev.since : iso,
    detail: detail ?? null,
    updatedAt: iso,
    lastConnectedAt: state === 'connected' ? iso : prev?.lastConnectedAt ?? null,
    lastLoggedOutAt:
      state === 'logged_out' ? (prev?.state === 'logged_out' ? prev.lastLoggedOutAt ?? prev.since : iso) : prev?.lastLoggedOutAt ?? null,
  };
  cache = next;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, FILE);
  } catch {
    /* status must never break the socket */
  }
  return next;
}
