import type { WaProvider } from '../src/types.ts';
import { getStatus, onEvent, setStatus } from './bus.ts';
import { startBaileys, stopBaileys } from './baileys.ts';
import { startCloud, stopCloud } from './cloud.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { ensureVerifyToken, WEBHOOK_PATH } from './cloud-config.ts';

export { getStatus, onEvent };

let starting: Promise<void> | null = null;

export function currentProvider(): WaProvider {
  return loadSettings().provider;
}

export async function startWhatsApp(provider?: WaProvider) {
  const chosen = provider || loadSettings().provider;
  if (starting) await starting;
  starting = (async () => {
    await stopBaileys();
    await stopCloud();
    saveSettings({ provider: chosen });
    setStatus({
      provider: chosen,
      connected: false,
      qr: null,
      me: null,
      error: null,
      webhookPath: WEBHOOK_PATH,
    });
    if (chosen === 'cloud') {
      ensureVerifyToken();
      await startCloud();
    } else {
      await startBaileys();
    }
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

export async function switchProvider(provider: WaProvider) {
  if (provider !== 'baileys' && provider !== 'cloud') {
    throw new Error('Unknown provider');
  }
  await startWhatsApp(provider);
  return getStatus();
}
