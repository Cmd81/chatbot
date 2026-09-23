/**
 * مچ‌میکر چت متنی داخل خودِ ربات تلگرام (نه مینی‌اپ).
 *
 * این فایل عمداً هیچ وابستگی‌ای به grammY ندارد تا بدون تلگرام هم قابل تست
 * باشد. همه‌چیز در حافظه است: نه دیتابیس، نه فایل، نه لاگ محتوا.
 */

/** نگاشت شناسه‌ی پیام‌ها تا «پاسخ به پیام» بین دو طرف کار کند. */
export class RelayMap {
  private readonly map = new Map<string, number>();
  private readonly order: string[] = [];

  constructor(private readonly max = 400) {}

  private static key(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * پیام `from` در چت `fromChat` به پیام `to` در چت `toChat` کپی شده است.
   * هر دو جهت ثبت می‌شود تا پاسخ از هر طرف پیدا شود.
   */
  remember(fromChat: number, from: number, toChat: number, to: number): void {
    this.set(RelayMap.key(fromChat, from), to);
    this.set(RelayMap.key(toChat, to), from);
  }

  private set(key: string, value: number): void {
    if (!this.map.has(key)) this.order.push(key);
    this.map.set(key, value);
    // سقف حافظه؛ قدیمی‌ترین نگاشت‌ها کنار می‌روند
    while (this.order.length > this.max) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /** شناسه‌ی متناظر همین پیام در چت طرف مقابل. */
  lookup(chatId: number, messageId: number): number | undefined {
    return this.map.get(RelayMap.key(chatId, messageId));
  }

  clear(): void {
    this.map.clear();
    this.order.length = 0;
  }
}

export interface ChatSession {
  a: number;
  b: number;
  relay: RelayMap;
  startedAt: number;
}

export type JoinResult =
  | { status: 'queued'; position: number }
  | { status: 'already_queued'; position: number }
  | { status: 'already_chatting'; partner: number }
  | { status: 'matched'; partner: number };

/**
 * صف FIFO ساده. چون هر کاربر تلگرام یک chatId یکتا دارد، امکان مچ شدن کسی
 * با خودش وجود ندارد.
 */
export class BotMatchmaker {
  private queue: number[] = [];
  private readonly sessions = new Map<number, ChatSession>();
  private matchCounter = 0;

  stats(): { waiting: number; chats: number; matches: number } {
    return { waiting: this.queue.length, chats: this.sessions.size / 2, matches: this.matchCounter };
  }

  isChatting(chatId: number): boolean {
    return this.sessions.has(chatId);
  }

  isWaiting(chatId: number): boolean {
    return this.queue.includes(chatId);
  }

  partnerOf(chatId: number): number | null {
    const session = this.sessions.get(chatId);
    if (!session) return null;
    return session.a === chatId ? session.b : session.a;
  }

  sessionOf(chatId: number): ChatSession | null {
    return this.sessions.get(chatId) ?? null;
  }

  join(chatId: number): JoinResult {
    const existing = this.partnerOf(chatId);
    if (existing !== null) return { status: 'already_chatting', partner: existing };

    const queuedAt = this.queue.indexOf(chatId);
    if (queuedAt !== -1) return { status: 'already_queued', position: queuedAt + 1 };

    const partner = this.queue.shift();
    if (partner === undefined) {
      this.queue.push(chatId);
      return { status: 'queued', position: this.queue.length };
    }

    const session: ChatSession = { a: partner, b: chatId, relay: new RelayMap(), startedAt: Date.now() };
    this.sessions.set(partner, session);
    this.sessions.set(chatId, session);
    this.matchCounter += 1;
    return { status: 'matched', partner };
  }

  /** خروج از صف. خروجی یعنی واقعاً در صف بود یا نه. */
  cancel(chatId: number): boolean {
    const at = this.queue.indexOf(chatId);
    if (at === -1) return false;
    this.queue.splice(at, 1);
    return true;
  }

  /**
   * پایان چت. شناسه‌ی طرف مقابل برگردانده می‌شود تا به او خبر داده شود.
   * نگاشت پیام‌ها همین‌جا کامل پاک می‌شود.
   */
  end(chatId: number): number | null {
    const session = this.sessions.get(chatId);
    this.cancel(chatId);
    if (!session) return null;

    const partner = session.a === chatId ? session.b : session.a;
    session.relay.clear();
    this.sessions.delete(session.a);
    this.sessions.delete(session.b);
    return partner;
  }
}
