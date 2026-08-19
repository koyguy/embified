import type { WaProvider, WaStatus } from '../src/types.ts';
import { publicConfig } from './cloud-config.ts';

type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();

function cloudFields(): Partial<WaStatus> {
  const pub = publicConfig();
  return {
    cloudConfigured: pub.configured,
    webhookPath: pub.webhookPath,
    webhookUrl: pub.webhookUrl,
    webhookPublicUrl: pub.webhookPublicUrl,
    verifyToken: pub.verifyToken,
    missingCloud: pub.missing,
    hasToken: pub.hasToken,
    hasPhoneNumberId: pub.hasPhoneNumberId,
  };
}

let status: WaStatus = {
  connected: false,
  qr: null,
  me: null,
  error: null,
  provider: 'baileys',
  ...cloudFields(),
};

export function onEvent(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(event: string, data: unknown) {
  for (const fn of listeners) {
    try {
      fn(event, data);
    } catch {
      /* ignore */
    }
  }
}

export function getStatus(): WaStatus {
  return { ...status, ...cloudFields() };
}

export function setStatus(partial: Partial<WaStatus>) {
  status = { ...status, ...partial, ...cloudFields() };
  emit('status', getStatus());
}

export function setProviderOnStatus(provider: WaProvider) {
  setStatus({ provider });
}
