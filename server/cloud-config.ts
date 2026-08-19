import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v22.0';
export const WEBHOOK_PATH = '/api/whatsapp/webhook';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'cloud.json');

export interface CloudFileConfig {
  token?: string;
  phoneNumberId?: string;
  verifyToken?: string;
  appSecret?: string;
  wabaId?: string;
  webhookPublicUrl?: string;
}

function readFileConfig(): CloudFileConfig {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function loadCloudFile(): CloudFileConfig {
  return readFileConfig();
}

export function saveCloudFile(partial: CloudFileConfig) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const next = { ...readFileConfig(), ...partial };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

function pick(fileVal?: string, ...envVals: (string | undefined)[]) {
  const fromFile = (fileVal || '').trim();
  if (fromFile) return fromFile;
  for (const v of envVals) {
    const t = (v || '').trim();
    if (t) return t;
  }
  return '';
}

export function cloudEnv() {
  const file = readFileConfig();
  return {
    token: pick(file.token, process.env.WHATSAPP_TOKEN, process.env.WHATSAPP_ACCESS_TOKEN),
    phoneNumberId: pick(file.phoneNumberId, process.env.WHATSAPP_PHONE_NUMBER_ID),
    verifyToken: pick(file.verifyToken, process.env.WHATSAPP_VERIFY_TOKEN),
    appSecret: pick(file.appSecret, process.env.WHATSAPP_APP_SECRET),
    wabaId: pick(file.wabaId, process.env.WHATSAPP_WABA_ID),
    webhookPublicUrl: pick(file.webhookPublicUrl, process.env.WEBHOOK_PUBLIC_URL),
  };
}

export function isCloudConfigured() {
  const { token, phoneNumberId, verifyToken } = cloudEnv();
  return Boolean(token && phoneNumberId && verifyToken);
}

export function missingCloudVars() {
  const { token, phoneNumberId, verifyToken } = cloudEnv();
  const missing: string[] = [];
  if (!token) missing.push('WHATSAPP_TOKEN');
  if (!phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!verifyToken) missing.push('WHATSAPP_VERIFY_TOKEN');
  return missing;
}

export function ensureVerifyToken() {
  const existing = cloudEnv().verifyToken;
  if (existing) return existing;
  const generated = `embified-${crypto.randomBytes(12).toString('hex')}`;
  saveCloudFile({ verifyToken: generated });
  return generated;
}

export function publicConfig() {
  const env = cloudEnv();
  return {
    configured: isCloudConfigured(),
    missing: missingCloudVars(),
    hasToken: Boolean(env.token),
    hasPhoneNumberId: Boolean(env.phoneNumberId),
    hasAppSecret: Boolean(env.appSecret),
    phoneNumberId: env.phoneNumberId,
    verifyToken: env.verifyToken,
    webhookPath: WEBHOOK_PATH,
    webhookPublicUrl: env.webhookPublicUrl,
    webhookUrl: env.webhookPublicUrl
      ? `${env.webhookPublicUrl.replace(/\/$/, '')}${WEBHOOK_PATH}`
      : WEBHOOK_PATH,
  };
}

export function graphUrl(pathName: string) {
  const clean = pathName.startsWith('/') ? pathName : `/${pathName}`;
  return `https://graph.facebook.com/${GRAPH_VERSION}${clean}`;
}
