import fs from 'fs';
import path from 'path';
import type { AppSettings, WaProvider } from '../src/types.ts';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

function defaultProvider(): WaProvider {
  const env = (process.env.WA_PROVIDER || '').trim().toLowerCase();
  if (env === 'cloud' || env === 'official') return 'cloud';
  return 'baileys';
}

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw.provider === 'cloud' || raw.provider === 'baileys') {
      return { provider: raw.provider };
    }
  } catch {
    /* first run */
  }
  return { provider: defaultProvider() };
}

export function saveSettings(next: AppSettings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
}
