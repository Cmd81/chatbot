#!/usr/bin/env node
/**
 * تست واحد اعتبارسنجی Telegram initData.
 * پیش‌نیاز: ابتدا بک‌اند را build کنید (cd backend && npm run build).
 *
 *   node scripts/test-initdata.mjs
 */
import { createHmac } from 'node:crypto';
import { verifyInitData } from '../backend/dist/telegram/initData.js';

const BOT_TOKEN = '123456:TEST-TOKEN-NOT-A-REAL-ONE';
const MAX_AGE = 24 * 60 * 60;

let passed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32m✔\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** ساخت یک initData معتبر، دقیقاً مثل کاری که تلگرام می‌کند. */
function makeInitData(fields, token = BOT_TOKEN) {
  const params = new URLSearchParams(fields);
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const nowSec = Math.floor(Date.now() / 1000);
const user = JSON.stringify({ id: 987654321, first_name: 'علی', username: 'ali' });

console.log('\n🧪 تست اعتبارسنجی initData تلگرام\n');

// ۱) حالت درست
{
  const data = makeInitData({ user, auth_date: String(nowSec), query_id: 'AAE' });
  const r = verifyInitData(data, BOT_TOKEN, MAX_AGE);
  check('initData معتبر پذیرفته می‌شود', r.ok === true);
  check('شناسه‌ی کاربر درست استخراج می‌شود', r.ok && r.user.id === 987654321);
}

// ۲) فیلد signature (نسخه‌های جدیدتر تلگرام)
{
  const data = makeInitData({ user, auth_date: String(nowSec), signature: 'abc_def-123' });
  const r = verifyInitData(data, BOT_TOKEN, MAX_AGE);
  check('initData همراه فیلد signature پذیرفته می‌شود', r.ok === true);
}

// ۳) دست‌کاری داده
{
  const data = makeInitData({ user, auth_date: String(nowSec) });
  const tampered = new URLSearchParams(data);
  tampered.set('user', JSON.stringify({ id: 1, first_name: 'هکر' }));
  const r = verifyInitData(tampered.toString(), BOT_TOKEN, MAX_AGE);
  check('داده‌ی دست‌کاری‌شده رد می‌شود', r.ok === false && r.reason === 'bad_signature');
}

// ۴) توکن اشتباه
{
  const data = makeInitData({ user, auth_date: String(nowSec) }, '999999:OTHER-BOT-TOKEN');
  const r = verifyInitData(data, BOT_TOKEN, MAX_AGE);
  check('امضا با توکن ربات دیگر رد می‌شود', r.ok === false && r.reason === 'bad_signature');
}

// ۵) انقضا (بیش از ۲۴ ساعت)
{
  const data = makeInitData({ user, auth_date: String(nowSec - MAX_AGE - 60) });
  const r = verifyInitData(data, BOT_TOKEN, MAX_AGE);
  check('auth_date قدیمی‌تر از ۲۴ ساعت رد می‌شود', r.ok === false && r.reason === 'expired');
}

// ۶) درست روی مرز ۲۴ ساعت
{
  const data = makeInitData({ user, auth_date: String(nowSec - MAX_AGE + 120) });
  const r = verifyInitData(data, BOT_TOKEN, MAX_AGE);
  check('کمی زیر ۲۴ ساعت هنوز معتبر است', r.ok === true);
}

// ۷) تاریخ آینده‌ی غیرمنطقی
{
  const data = makeInitData({ user, auth_date: String(nowSec + 3600) });
  const r = verifyInitData(data, BOT_TOKEN, MAX_AGE);
  check('auth_date در آینده رد می‌شود', r.ok === false && r.reason === 'expired');
}

// ۸) نبود hash
{
  const params = new URLSearchParams({ user, auth_date: String(nowSec) });
  const r = verifyInitData(params.toString(), BOT_TOKEN, MAX_AGE);
  check('نبود hash رد می‌شود', r.ok === false && r.reason === 'missing_hash');
}

// ۹) hash نامعتبر / ورودی خالی
{
  check('hash با طول اشتباه رد می‌شود', verifyInitData(`user=${encodeURIComponent(user)}&auth_date=${nowSec}&hash=00ff`, BOT_TOKEN, MAX_AGE).ok === false);
  check('رشته‌ی خالی رد می‌شود', verifyInitData('', BOT_TOKEN, MAX_AGE).ok === false);
  check('توکن خالی رد می‌شود', verifyInitData(makeInitData({ user, auth_date: String(nowSec) }), '', MAX_AGE).ok === false);
}

// ۱۰) نبود user
{
  const data = makeInitData({ auth_date: String(nowSec), query_id: 'AAE' });
  const r = verifyInitData(data, BOT_TOKEN, MAX_AGE);
  check('نبود فیلد user رد می‌شود', r.ok === false && r.reason === 'missing_user');
}

console.log(`\n${'─'.repeat(52)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m✔ همه‌ی ${passed} بررسی با موفقیت انجام شد.\x1b[0m\n`);
  process.exit(0);
}
console.log(`\x1b[31m✘ ${failures.length} مورد ناموفق:\x1b[0m`);
for (const f of failures) console.log(`   • ${f}`);
console.log();
process.exit(1);
