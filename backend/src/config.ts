/**
 * پیکربندی از روی متغیرهای محیطی.
 * هیچ مقدار حساسی (توکن ربات، کلید LiveKit) داخل کد یا گیت نگهداری نمی‌شود.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`متغیر محیطی «${name}» تعریف نشده است.`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`متغیر محیطی «${name}» باید عدد باشد.`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export type TelegramMode = 'polling' | 'webhook' | 'off';

const telegramMode = str('TELEGRAM_MODE', 'polling') as TelegramMode;
if (!['polling', 'webhook', 'off'].includes(telegramMode)) {
  throw new Error('TELEGRAM_MODE باید یکی از polling | webhook | off باشد.');
}

export const config = {
  env: str('NODE_ENV', 'production'),
  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 3000),

  /** نشانی عمومی Mini App، مثلا https://chat.onlane.top */
  publicUrl: str('PUBLIC_URL', 'https://chat.onlane.top').replace(/\/+$/, ''),

  /** مسیر فایل‌های استاتیک فرانت (خروجی Vite) */
  staticDir: str('STATIC_DIR', 'public'),

  livekit: {
    /** نشانی‌ای که به کلاینت داده می‌شود */
    url: str('LIVEKIT_URL', 'wss://chat.onlane.top'),
    /** نشانی داخلی برای فراخوانی Server API */
    apiUrl: str('LIVEKIT_API_URL', 'http://127.0.0.1:7880'),
    apiKey: str('LIVEKIT_API_KEY'),
    apiSecret: str('LIVEKIT_API_SECRET'),
    /** اعتبار توکن شرکت‌کننده */
    tokenTtlSeconds: int('LIVEKIT_TOKEN_TTL', 2 * 60 * 60),
    /** اتاق بعد از خالی شدن چند ثانیه بسته شود */
    roomEmptyTimeout: int('LIVEKIT_ROOM_EMPTY_TIMEOUT', 60),
  },

  telegram: {
    mode: telegramMode,
    botToken: str('TELEGRAM_BOT_TOKEN', ''),
    /** برای حالت webhook: مسیر و هدر مخفی */
    webhookSecret: str('TELEGRAM_WEBHOOK_SECRET', ''),
    /** در صورت نیاز به Bot API سرور شخصی/پروکسی */
    apiRoot: str('TELEGRAM_API_ROOT', 'https://api.telegram.org'),
    /** تنظیم خودکار دکمه‌ی منوی ربات هنگام بالا آمدن */
    setMenuButton: bool('TELEGRAM_SET_MENU_BUTTON', true),
  },

  auth: {
    /** initData قدیمی‌تر از این مقدار رد می‌شود (ثانیه) */
    maxInitDataAgeSeconds: int('INITDATA_MAX_AGE', 24 * 60 * 60),
    /** ورود مهمان (سایت معمولی) فعال باشد؟ */
    allowGuest: bool('ALLOW_GUEST', true),
  },

  ws: {
    /** فاصله‌ی ping سمت سرور (میلی‌ثانیه) */
    heartbeatIntervalMs: int('WS_HEARTBEAT_MS', 25_000),
    /** حداکثر اندازه‌ی پیام ورودی */
    maxPayloadBytes: int('WS_MAX_PAYLOAD', 16 * 1024),
    /**
     * سقف تعداد پیام در هر بازه، فقط برای هر اتصال (نه بر اساس IP).
     * چون ممکن است همه‌ی کاربران پشت یک VPN با IP یکسان باشند.
     */
    maxMessagesPerWindow: int('WS_MSG_LIMIT', 60),
    rateWindowMs: int('WS_RATE_WINDOW_MS', 10_000),
  },
} as const;

export function assertRuntimeConfig(): void {
  if (config.telegram.mode !== 'off' && !config.telegram.botToken) {
    throw new Error('برای فعال بودن ربات، TELEGRAM_BOT_TOKEN لازم است (یا TELEGRAM_MODE=off بگذارید).');
  }
  if (config.telegram.mode === 'webhook' && !config.telegram.webhookSecret) {
    throw new Error('در حالت webhook باید TELEGRAM_WEBHOOK_SECRET تنظیم شود.');
  }
  if (config.livekit.apiSecret.length < 32) {
    throw new Error('LIVEKIT_API_SECRET باید حداقل ۳۲ کاراکتر باشد.');
  }
}
