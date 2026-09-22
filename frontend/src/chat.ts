/**
 * گفتگوی متنی روی کانال دادهٔ LiveKit.
 *
 * ⚠️ درباره‌ی حریم خصوصی، صادقانه:
 *  • هیچ پیامی در سرور ما **ذخیره نمی‌شود** — نه دیتابیس، نه فایل، نه لاگ.
 *    LiveKit بسته‌ها را فقط در حافظه بازپخش می‌کند.
 *  • هیچ پیامی در مرورگر هم ذخیره نمی‌شود — نه localStorage، نه IndexedDB.
 *    همه‌چیز فقط در یک آرایه‌ی جاوااسکریپت است و با پایان تماس پاک می‌شود.
 *  • ولی چون معماری SFU است، بسته‌ها **از سرور عبور می‌کنند** و در همان
 *    لحظه‌ی عبور رمزگشایی می‌شوند (TLS تا سرور، TLS از سرور). یعنی این
 *    رمزنگاری سرتاسری (end-to-end) نیست. اگر لازم شد، باید کلید مشترک بین
 *    دو کلاینت مبادله و متن قبل از ارسال رمز شود.
 */

export const CHAT_TOPIC = 'chat';
export const MAX_TEXT_LENGTH = 500;
export const MAX_MESSAGES = 200;

export interface ChatMessage {
  id: string;
  text: string;
  mine: boolean;
  at: number;
}

interface WirePacket {
  t: 'msg';
  id: string;
  text: string;
}

// کاراکترهای کنترلی (به‌جز \n و \t) ظاهر پیام را خراب می‌کنند
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// کاراکترهای جهت‌دهی دوطرفه؛ در متن فارسی می‌شود با آن‌ها ظاهر پیام را جعل کرد
const BIDI_RE = /[‪-‮⁦-⁩]/g;

/** پاک‌سازی و اعتبارسنجی متن. خروجی null یعنی پیام دور انداخته شود. */
export function sanitize(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CONTROL_RE, '').replace(BIDI_RE, '').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_TEXT_LENGTH ? cleaned.slice(0, MAX_TEXT_LENGTH) : cleaned;
}

export function newMessageId(): string {
  return crypto.randomUUID();
}

/** LiveKit بافر اشتراکی نمی‌پذیرد، پس نوع دقیق لازم است. */
export type ChatPayload = Uint8Array<ArrayBuffer>;

export function encode(id: string, text: string): ChatPayload {
  const packet: WirePacket = { t: 'msg', id, text };
  return new TextEncoder().encode(JSON.stringify(packet)) as ChatPayload;
}

/** رمزگشایی بسته‌ی دریافتی. هر چیز نامعتبر بی‌صدا دور انداخته می‌شود. */
export function decode(payload: Uint8Array): { id: string; text: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const packet = parsed as Partial<WirePacket>;
  if (packet.t !== 'msg') return null;

  const text = sanitize(packet.text);
  if (!text) return null;

  const id = typeof packet.id === 'string' && packet.id.length > 0 && packet.id.length <= 64 ? packet.id : newMessageId();
  return { id, text };
}

/**
 * نگهدارنده‌ی پیام‌ها — فقط در حافظه.
 * هیچ‌جا روی دیسک نوشته نمی‌شود و با `clear()` کامل پاک می‌شود.
 */
export class ChatStore {
  private items: ChatMessage[] = [];
  private seen = new Set<string>();

  get messages(): readonly ChatMessage[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  /** خروجی null یعنی تکراری بود و اضافه نشد. */
  add(input: { id: string; text: string; mine: boolean }): ChatMessage | null {
    if (this.seen.has(input.id)) return null;
    this.seen.add(input.id);

    const message: ChatMessage = { ...input, at: Date.now() };
    this.items.push(message);

    // سقف حافظه؛ قدیمی‌ترها کنار می‌روند
    if (this.items.length > MAX_MESSAGES) {
      const dropped = this.items.splice(0, this.items.length - MAX_MESSAGES);
      for (const d of dropped) this.seen.delete(d.id);
    }
    return message;
  }

  clear(): void {
    this.items.length = 0;
    this.seen.clear();
  }
}

/** سقف ارسال، فقط سمت کلاینت و فقط برای همین اتصال (نه بر اساس IP). */
export class SendLimiter {
  private times: number[] = [];

  constructor(
    private readonly max = 10,
    private readonly windowMs = 5_000,
  ) {}

  allow(now = Date.now()): boolean {
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }

  reset(): void {
    this.times = [];
  }
}
