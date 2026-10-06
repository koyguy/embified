export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';

export type WaProvider = 'baileys' | 'cloud';

export interface MediaAttachment {
  id: string;
  kind: MediaKind;
  mimetype: string;
  fileName: string;
  size: number;
  url: string;
}

export interface ChatMessage {
  id: string;
  groupId: string;
  from: string;
  authorName: string;
  text: string;
  fromMe: boolean;
  timestamp: string;
  media?: MediaAttachment[];
  /** 'history' = recovered from WhatsApp's history sync on (re)link; absent/'live' = received live. */
  source?: 'live' | 'history';
  /** Media we know existed but couldn't (or chose not to) download. */
  mediaUnavailable?: { kind: MediaKind; fileName: string };
}

export type WaLinkState = 'connecting' | 'qr' | 'connected' | 'disconnected' | 'logged_out';

export interface GroupSummary {
  id: string;
  name: string;
  memberCount?: number;
  lastMessage?: string;
  lastAt?: string;
  unread: number;
  messageCount: number;
  kind?: 'group' | 'dm';
}

export interface WaStatus {
  connected: boolean;
  qr?: string | null;
  me?: { id: string; name?: string } | null;
  error?: string | null;
  provider: WaProvider;
  cloudConfigured: boolean;
  webhookPath: string;
  webhookUrl?: string;
  webhookPublicUrl?: string;
  verifyToken?: string;
  missingCloud?: string[];
  hasToken?: boolean;
  hasPhoneNumberId?: boolean;
  /** Linked-device lifecycle (persisted; `since` survives restarts). */
  waState?: WaLinkState;
  waStateSince?: string;
}

export interface AppSettings {
  provider: WaProvider;
}
