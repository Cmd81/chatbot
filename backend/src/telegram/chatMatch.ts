import { randomUUID } from 'node:crypto';

/**
 * مچ‌میکر چت متنی داخل خودِ ربات تلگرام (نه مینی‌اپ).
 *
 * این فایل عمداً هیچ وابستگی‌ای به grammY ندارد تا بدون تلگرام هم قابل تست
 * باشد. همه‌چیز در حافظه است: نه دیتابیس، نه فایل، نه لاگ محتوا.
 */

interface RelayEntry {
  /** شناسه‌ی متناظر همین پیام در چت طرف مقابل. */
  peer: number;
  /**
   * آیا این پیام را خودِ صاحبِ آن چت فرستاده؟
   *
   * لازم است چون «حذف برای همه» فقط باید روی پیام‌های خودِ کاربر کار کند.
   * بدون این، کاربر می‌توانست با reply زدن روی پیامِ رسیده، پیام طرف مقابل
   * را از چت او پاک کند.
   */
  original: boolean;
}

/** نگاشت شناسه‌ی پیام‌ها تا «پاسخ به پیام» و «حذف» بین دو طرف کار کند. */
export class RelayMap {
  private readonly map = new Map<string, RelayEntry>();
  private readonly order: string[] = [];

  // سقف بالا چون «پاک کردن کل گفتگو» به همه‌ی شناسه‌ها نیاز دارد، نه چند تای آخر.
  constructor(private readonly max = 3000) {}

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
    this.set(RelayMap.key(fromChat, from), { peer: to, original: true });
    this.set(RelayMap.key(toChat, to), { peer: from, original: false });
  }

  private set(key: string, value: RelayEntry): void {
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
    return this.map.get(RelayMap.key(chatId, messageId))?.peer;
  }

  /** آیا این پیام را خودِ صاحب همین چت فرستاده (نه کپیِ ربات)؟ */
  isOriginal(chatId: number, messageId: number): boolean {
    return this.map.get(RelayMap.key(chatId, messageId))?.original === true;
  }

  /**
   * پیام‌هایی که **خودِ صاحب این چت** فرستاده، به‌همراه شناسه‌ی کپی‌شان در چت
   * طرف مقابل. پایه‌ی «پاک کردن پیام‌های من».
   */
  ownMessages(chatId: number): Array<{ mine: number; theirs: number }> {
    const out: Array<{ mine: number; theirs: number }> = [];
    for (const [key, entry] of this.map) {
      if (!entry.original) continue;
      const sep = key.lastIndexOf(':');
      if (Number(key.slice(0, sep)) !== chatId) continue;
      const mine = Number(key.slice(sep + 1));
      if (Number.isFinite(mine)) out.push({ mine, theirs: entry.peer });
    }
    return out;
  }

  /**
   * فراموش کردن پیام‌های یک طرف، بعد از اینکه پاک شدند.
   * نگاشت‌های طرف مقابل دست‌نخورده می‌مانند تا او هم بتواند پیام‌های خودش را
   * پاک کند.
   */
  forgetOwn(chatId: number, partnerId: number): void {
    const doomed = new Set<string>();
    for (const pair of this.ownMessages(chatId)) {
      doomed.add(RelayMap.key(chatId, pair.mine));
      doomed.add(RelayMap.key(partnerId, pair.theirs));
    }
    if (doomed.size === 0) return;
    for (const key of doomed) this.map.delete(key);
    // ترتیب هم باید هرس شود وگرنه سقف حافظه اشتباه حساب می‌شود
    const kept = this.order.filter((k) => !doomed.has(k));
    this.order.length = 0;
    this.order.push(...kept);
  }

  clear(): void {
    this.map.clear();
    this.order.length = 0;
  }
}

/** گفتگوی تمام‌شده‌ای که هنوز می‌شود پاکش کرد. */
export interface EndedSession {
  id: string;
  a: number;
  b: number;
  relay: RelayMap;
  endedAt: number;
}

export interface ChatSession {
  /** شناسه‌ی کوتاه گفتگو؛ در callback_data دکمه‌ی اینلاین می‌رود. */
  id: string;
  a: number;
  b: number;
  relay: RelayMap;
  startedAt: number;
  /** آخرین پیامی که هر طرف فرستاده — برای دکمه‌ی «حذف آخرین». */
  lastSent: Map<number, number>;
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
  /**
   * گفتگوهای تازه‌تمام‌شده، تا کاربر بتواند بعدش «پاک کردن کل گفتگو» را بزند.
   * برای هر کاربر فقط آخرین گفتگو نگه داشته می‌شود، پس مصرف حافظه به تعداد
   * کاربران بستگی دارد نه تعداد چت‌ها.
   */
  private readonly recent = new Map<number, EndedSession>();
  private matchCounter = 0;

  /** بعد از این مدت، تلگرام هم اجازه‌ی حذف نمی‌دهد؛ پس نگه داشتنش بی‌فایده است. */
  private static readonly RECENT_TTL_MS = 48 * 60 * 60 * 1000;

  stats(): { waiting: number; chats: number; matches: number; recent: number } {
    return {
      waiting: this.queue.length,
      chats: this.sessions.size / 2,
      matches: this.matchCounter,
      recent: this.recent.size,
    };
  }

  /** آخرین گفتگوی تمام‌شده‌ی این کاربر، اگر هنوز قابل پاک کردن باشد. */
  recentOf(chatId: number): EndedSession | null {
    this.purgeRecent();
    return this.recent.get(chatId) ?? null;
  }

  /** بعد از پاک کردن، رکورد برای هر دو طرف دور انداخته می‌شود. */
  forgetRecent(chatId: number): void {
    const ended = this.recent.get(chatId);
    if (!ended) return;
    ended.relay.clear();
    this.recent.delete(ended.a);
    this.recent.delete(ended.b);
  }

  private purgeRecent(): void {
    const cutoff = Date.now() - BotMatchmaker.RECENT_TTL_MS;
    for (const [chatId, ended] of this.recent) {
      if (ended.endedAt < cutoff) {
        ended.relay.clear();
        this.recent.delete(chatId);
      }
    }
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

    const session: ChatSession = {
      id: randomUUID().slice(0, 8),
      a: partner,
      b: chatId,
      relay: new RelayMap(),
      startedAt: Date.now(),
      lastSent: new Map(),
    };
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
    session.lastSent.clear();
    this.sessions.delete(session.a);
    this.sessions.delete(session.b);

    // نگاشت پیام‌ها عمداً پاک نمی‌شود: بدون آن «پاک کردن کل گفتگو» غیرممکن
    // می‌شد، چون دیگر نمی‌دانستیم کدام پیامِ این چت با کدام پیامِ آن چت
    // متناظر است.
    const ended: EndedSession = {
      id: session.id,
      a: session.a,
      b: session.b,
      relay: session.relay,
      endedAt: Date.now(),
    };
    this.recent.set(session.a, ended);
    this.recent.set(session.b, ended);
    this.purgeRecent();

    return partner;
  }
}
