export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'other';

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
}

export interface WaStatus {
  connected: boolean;
  qr?: string | null;
  me?: { id: string; name?: string } | null;
  error?: string | null;
}
