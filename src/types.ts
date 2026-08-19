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
}

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
}

export interface AppSettings {
  provider: WaProvider;
}
