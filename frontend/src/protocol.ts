export type ClientMessage =
  | { type: 'auth'; mode: 'telegram'; initData: string }
  | { type: 'auth'; mode: 'guest'; guestId?: string }
  | { type: 'join' }
  | { type: 'cancel' }
  | { type: 'leave' }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'ready'; mode: 'telegram' | 'guest'; sessionId: string; guestId?: string }
  | { type: 'waiting' }
  | { type: 'matched'; room: string; url: string; token: string }
  | { type: 'partner_left' }
  | { type: 'call_ended' }
  | { type: 'cancelled'; reason?: 'user' | 'replaced' }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };
