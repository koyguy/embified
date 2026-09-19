import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { DATA_DIR } from './store.ts';

const AUTH_DIR = path.resolve(process.env.AUTH_DIR || path.join(process.cwd(), 'auth_info'));
const DEFAULT_QUOTA = 200 * 1024 * 1024 * 1024; // Always Free story: 200 GB

export function getQuotaBytes() {
  const raw = process.env.EMBIFIED_QUOTA_BYTES;
  const n = raw ? Number(raw) : DEFAULT_QUOTA;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUOTA;
}

function dirSizeBytes(root: string, budgetMs = 1500): number {
  if (!fs.existsSync(root)) return 0;
  const start = Date.now();
  let total = 0;
  const stack = [root];
  while (stack.length) {
    if (Date.now() - start > budgetMs) break;
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      try {
        if (ent.isDirectory()) stack.push(p);
        else if (ent.isFile()) total += fs.statSync(p).size;
      } catch {
        /* skip */
      }
    }
  }
  return total;
}

type MountInfo = { total: number; used: number; available: number; mount: string };

function mountFor(dir: string): MountInfo | null {
  const statfs = (fs as any).statfsSync as
    | undefined
    | ((p: string) => { bsize: number; blocks: number; bavail: number; bfree: number });
  try {
    if (typeof statfs === 'function') {
      const s = statfs(dir);
      const total = Number(s.blocks) * Number(s.bsize);
      const available = Number(s.bavail) * Number(s.bsize);
      const used = total - Number(s.bfree) * Number(s.bsize);
      return { total, used, available, mount: dir };
    }
  } catch {
    /* fall through */
  }
  try {
    const out = execFileSync('df', ['-k', '-P', dir], { encoding: 'utf8' });
    const line = out.trim().split('\n')[1];
    if (!line) return null;
    const parts = line.split(/\s+/);
    const total = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const available = Number(parts[3]) * 1024;
    const mount = parts.slice(5).join(' ') || parts[5];
    return { total, used, available, mount };
  } catch {
    return null;
  }
}

function human(n: number) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function getDiskReport() {
  const quotaBytes = getQuotaBytes();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  const dataBytes = dirSizeBytes(DATA_DIR);
  const authBytes = dirSizeBytes(AUTH_DIR);
  const vaultBytes = dataBytes + authBytes;
  const mount = mountFor(DATA_DIR);
  const pctQuota = quotaBytes ? (vaultBytes / quotaBytes) * 100 : 0;
  const pctDisk = mount && mount.total ? (mount.used / mount.total) * 100 : null;

  return {
    ok: true as const,
    quotaBytes,
    vaultBytes,
    dataBytes,
    authBytes,
    dataDir: DATA_DIR,
    authDir: AUTH_DIR,
    mount,
    percentOfQuota: Math.round(pctQuota * 1000) / 1000,
    percentOfDisk: pctDisk == null ? null : Math.round(pctDisk * 1000) / 1000,
    human: {
      quota: human(quotaBytes),
      vault: human(vaultBytes),
      data: human(dataBytes),
      auth: human(authBytes),
      diskTotal: mount ? human(mount.total) : null,
      diskUsed: mount ? human(mount.used) : null,
      diskAvailable: mount ? human(mount.available) : null,
    },
    story:
      'Embified treats Oracle Always Free ~200 GB capacity as your personal WhatsApp group vault quota.',
  };
}
