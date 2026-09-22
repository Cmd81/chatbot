/** پل کوچک روی Telegram.WebApp — بیرون از تلگرام همه‌چیز بی‌اثر است. */

export interface TelegramWebApp {
  initData: string;
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string | undefined>;
  isExpanded: boolean;
  ready(): void;
  expand(): void;
  close(): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  onEvent?(event: string, cb: () => void): void;
  HapticFeedback?: {
    impactOccurred?(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred?(type: 'error' | 'success' | 'warning'): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const tg: TelegramWebApp | null = window.Telegram?.WebApp ?? null;

/** آیا واقعاً داخل تلگرام باز شده؟ (initData فقط داخل تلگرام مقدار دارد) */
export const insideTelegram: boolean = Boolean(tg && typeof tg.initData === 'string' && tg.initData.length > 0);

function setVar(name: string, value: string | undefined): void {
  if (value) document.documentElement.style.setProperty(name, value);
}

export function initTelegram(): void {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    // جلوگیری از بسته‌شدن ناخواسته‌ی مینی‌اپ وسط تماس
    tg.disableVerticalSwipes?.();

    const p = tg.themeParams ?? {};
    setVar('--bg', p.bg_color);
    setVar('--bg-soft', p.secondary_bg_color);
    setVar('--text', p.text_color);
    setVar('--text-dim', p.hint_color);
    setVar('--accent', p.button_color);
    setVar('--accent-text', p.button_text_color);
    setVar('--danger', p.destructive_text_color);

    if (p.bg_color) {
      tg.setHeaderColor?.(p.bg_color);
      tg.setBackgroundColor?.(p.bg_color);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', p.bg_color);
    }
  } catch {
    /* اگر نسخه‌ی تلگرام قدیمی باشد، بی‌خیال می‌شویم */
  }
}

export function haptic(type: 'success' | 'error' | 'warning'): void {
  try {
    tg?.HapticFeedback?.notificationOccurred?.(type);
  } catch {
    /* noop */
  }
}

export function setClosingConfirmation(on: boolean): void {
  try {
    if (on) tg?.enableClosingConfirmation?.();
    else tg?.disableClosingConfirmation?.();
  } catch {
    /* noop */
  }
}
