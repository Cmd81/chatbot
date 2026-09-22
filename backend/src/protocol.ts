/** پیام‌هایی که کلاینت می‌فرستد. */
export type ClientMessage =
  | { type: 'auth'; mode: 'telegram'; initData: string }
  | { type: 'auth'; mode: 'guest'; guestId?: string }
  | { type: 'join' }
  | { type: 'cancel' }
  | { type: 'leave' }
  | { type: 'ping' };

export type ErrorCode =
  | 'bad_message'
  | 'not_authenticated'
  | 'already_authenticated'
  | 'auth_failed'
  | 'guest_disabled'
  | 'already_in_call'
  | 'rate_limited'
  | 'match_failed'
  | 'server_error';

/** پیام‌هایی که سرور می‌فرستد. */
export type ServerMessage =
  | { type: 'ready'; mode: 'telegram' | 'guest'; sessionId: string; guestId?: string }
  | { type: 'waiting' }
  | { type: 'matched'; room: string; url: string; token: string }
  | { type: 'partner_left' }
  | { type: 'call_ended' }
  | { type: 'cancelled'; reason?: 'user' | 'replaced' }
  | { type: 'pong' }
  | { type: 'error'; code: ErrorCode; message: string };

export type PeerState = 'idle' | 'waiting' | 'matching' | 'matched';

/** انتزاع یک اتصال؛ مچ‌میکر مستقیماً به WebSocket وابسته نیست (برای تست‌پذیری). */
export interface Peer {
  readonly connId: string;
  /** شناسه‌ی پایدار کاربر: `tg:<id>` یا `guest:<uuid>` — هرگز به LiveKit نمی‌رود. */
  identity: string | null;
  state: PeerState;
  roomName: string | null;
  partner: Peer | null;
  send(msg: ServerMessage): void;
  isOpen(): boolean;
  close(code?: number, reason?: string): void;
}
