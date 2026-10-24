export interface LineEvent {
  type: string; webhookEventId: string; timestamp: number; replyToken?: string;
  source: { type: string; userId?: string };
  message?: { type: string; text?: string };
}
export interface Config {
  port: number; databaseUrl: string; mode: 'test' | 'live'; responseMode: 'fixed' | 'ai';
  lineSecret: string; lineToken: string; ownerId: string; testUserIds: string[];
  aiKey?: string; aiModel?: string; knowledgePath: string; bookingUrl: string; publicSiteUrl: string;
}
export interface AiResult {
  reply: string; summary: string; service: string | null; requestedTime: string | null;
  bookingStatus: 'none' | 'requested' | 'self_reported'; needsHuman: boolean; nextAction: string;
}
export interface AiInput { text: string; history: { role: 'user' | 'assistant'; content: string }[]; knowledge: string; receivedAt: string }
export interface AiClient { generate(input: AiInput): Promise<AiResult> }
export interface LineClient { reply(token: string, text: string): Promise<void>; push(userId: string, text: string, retryKey: string): Promise<void> }
export type Delivery = 'sent' | 'failed' | 'unknown' | 'not_sent';
export interface EventJob {
  id: string; userId: string; customerRef: string; event: LineEvent; receivedAt: Date;
  leaseToken: string; previouslySending: boolean; attempts: number;
}
export interface Outcome extends AiResult { delivery: Delivery; skipTask?: boolean }
export interface Session { userId: string; customerRef: string; handoff: boolean }
export interface Task {
  id: string; customerRef: string; status: string; bookingStatus: string; summary: string;
  nextAction: string; service: string | null; requestedTime: string | null; receivedAt: Date;
}
export interface NotificationJob { id: string; ownerId: string; text: string; retryKey: string; leaseToken: string; attempts: number }
export interface Database {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
