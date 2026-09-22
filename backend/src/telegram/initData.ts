import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export type InitDataResult =
  | { ok: true; user: TelegramUser; authDate: Date }
  | { ok: false; reason: 'malformed' | 'missing_hash' | 'bad_signature' | 'expired' | 'missing_user' };

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function equalsHex(a: string, b: Buffer): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(a, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== b.length) return false;
  return timingSafeEqual(expected, b);
}

function dataCheckString(params: URLSearchParams, exclude: string[]): string {
  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    if (exclude.includes(k)) continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  return pairs.join('\n');
}

/**
 * اعتبارسنجی `Telegram.WebApp.initData` طبق مستندات رسمی تلگرام:
 *   secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
 *   hash       = HEX(HMAC_SHA256(key=secret_key, message=data_check_string))
 *
 * `data_check_string` از همه‌ی فیلدها به‌جز `hash` ساخته می‌شود. برخی نسخه‌های
 * تلگرام فیلد `signature` (امضای Ed25519 برای اعتبارسنجی شخص ثالث) را هم
 * اضافه می‌کنند؛ برای سازگاری، اگر حالت اول جواب نداد بدون `signature` هم
 * بررسی می‌شود. هر دو حالت به‌طور یکسان با توکن ربات امضا شده‌اند.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  now: Date = new Date(),
): InitDataResult {
  if (!initData || !botToken) return { ok: false, reason: 'malformed' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing_hash' };

  const secretKey = hmac('WebAppData', botToken);
  const candidates = [dataCheckString(params, ['hash']), dataCheckString(params, ['hash', 'signature'])];
  const matched = candidates.some((dcs) => equalsHex(hash, hmac(secretKey, dcs)));
  if (!matched) return { ok: false, reason: 'bad_signature' };

  const authDateRaw = params.get('auth_date');
  const authDateSec = Number(authDateRaw);
  if (!authDateRaw || !Number.isFinite(authDateSec)) return { ok: false, reason: 'malformed' };
  const ageSeconds = Math.floor(now.getTime() / 1000) - authDateSec;
  // زمان آینده هم مشکوک است (اختلاف ساعت تا ۵ دقیقه تحمل می‌شود)
  if (ageSeconds > maxAgeSeconds || ageSeconds < -300) return { ok: false, reason: 'expired' };

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'missing_user' };
  let user: TelegramUser;
  try {
    user = JSON.parse(userRaw) as TelegramUser;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof user.id !== 'number' || !Number.isFinite(user.id)) return { ok: false, reason: 'missing_user' };

  return { ok: true, user, authDate: new Date(authDateSec * 1000) };
}
