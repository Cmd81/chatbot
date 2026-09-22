#!/usr/bin/env node
/**
 * تست دود (smoke test) مچ‌میکر.
 *
 * دو کلاینت WebSocket جعلی می‌سازد و بررسی می‌کند:
 *   ۱. نفر اول پیام waiting می‌گیرد
 *   ۲. با ورود نفر دوم، هر دو پیام matched با اتاق یکسان می‌گیرند
 *   ۳. توکن‌های LiveKit متفاوت، ناشناس و مخصوص همان اتاق هستند
 *   ۴. با leave یکی، طرف مقابل partner_left می‌گیرد
 *   ۵. یک کاربر با خودش مچ نمی‌شود و دو بار وارد صف نمی‌شود
 *   ۶. cancel کاربر را از صف خارج می‌کند
 *
 * اجرا:
 *   node scripts/test-match.mjs
 *   WS_URL=wss://chat.onlane.top/ws node scripts/test-match.mjs
 */

import { randomUUID } from 'node:crypto';

const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:3000/ws';
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT ?? 15000);

if (typeof WebSocket === 'undefined') {
  console.error('این اسکریپت به Node.js نسخه ۲۲ به بالا (با WebSocket داخلی) نیاز دارد.');
  process.exit(1);
}

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✔\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class TestClient {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.waiters = [];
    this.ws = new WebSocket(WS_URL);
    this.opened = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${name}: اتصال باز نشد`)), TIMEOUT_MS);
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      this.ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(`${name}: خطای اتصال به ${WS_URL}`)); });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      const idx = this.waiters.findIndex((w) => w.type === msg.type);
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        this.inbox.push(msg);
      }
    });
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }

  /** منتظر پیامی با نوع مشخص می‌ماند (صف پیام‌های رسیده هم بررسی می‌شود). */
  expect(type, timeout = TIMEOUT_MS) {
    const idx = this.inbox.findIndex((m) => m.type === type);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`${this.name}: پیام «${type}» نرسید (صندوق: ${JSON.stringify(this.inbox.map((m) => m.type))})`));
      }, timeout);
      this.waiters.push({ type, resolve, timer });
    });
  }

  /** مطمئن می‌شود پیامی با این نوع در بازه‌ی داده‌شده نمی‌رسد. */
  async expectSilence(type, ms = 1200) {
    try {
      await this.expect(type, ms);
      return false;
    } catch {
      return true;
    }
  }

  close() { try { this.ws.close(); } catch { /* noop */ } }
}

function decodeJwt(token) {
  const part = token.split('.')[1];
  if (!part) throw new Error('توکن نامعتبر');
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

async function authGuest(client, guestId) {
  await client.opened;
  client.send(guestId ? { type: 'auth', mode: 'guest', guestId } : { type: 'auth', mode: 'guest' });
  const ready = await client.expect('ready');
  return ready.guestId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n🧪 تست مچ‌میکر روی ${WS_URL}\n`);
  const open = [];
  const track = (c) => { open.push(c); return c; };

  try {
    // ── سناریوی ۱: مچ شدن دو کاربر متفاوت ──────────────────────────────────
    console.log('۱) مچ شدن دو کاربر:');
    const a = track(new TestClient('A'));
    const b = track(new TestClient('B'));
    const guestA = await authGuest(a);
    const guestB = await authGuest(b);
    check('هر دو کلاینت احراز هویت شدند', Boolean(guestA && guestB && guestA !== guestB));

    a.send({ type: 'join' });
    await a.expect('waiting');
    check('نفر اول پیام waiting گرفت', true);

    const quiet = await a.expectSilence('matched', 800);
    check('نفر اول تا نیامدن نفر دوم مچ نشد', quiet);

    b.send({ type: 'join' });
    const [ma, mb] = await Promise.all([a.expect('matched'), b.expect('matched')]);
    check('هر دو پیام matched گرفتند', true);
    check('اتاق هر دو یکی است', ma.room === mb.room, `${ma.room} vs ${mb.room}`);
    check('آدرس LiveKit فرستاده شد', typeof ma.url === 'string' && /^wss?:\/\//.test(ma.url), ma.url);
    check('توکن‌ها متفاوت‌اند', Boolean(ma.token) && Boolean(mb.token) && ma.token !== mb.token);

    const pa = decodeJwt(ma.token);
    const pb = decodeJwt(mb.token);
    check('توکن برای همان اتاق صادر شده', pa.video?.room === ma.room && pb.video?.room === mb.room);
    check('اجازه‌ی join/publish/subscribe دارد', pa.video?.roomJoin === true && pa.video?.canPublish === true && pa.video?.canSubscribe === true);
    check('هویت LiveKit ناشناس است (بدون شناسه‌ی مهمان/تلگرام)', /^anon_[0-9a-f]{16}$/.test(pa.sub) && !pa.sub.includes(guestA) && pa.sub !== pb.sub, `${pa.sub} / ${pb.sub}`);

    // ── سناریوی ۲: خروج یکی از طرفین ───────────────────────────────────────
    console.log('\n۲) خروج یکی از طرفین:');
    a.send({ type: 'leave' });
    await b.expect('partner_left');
    check('طرف مقابل پیام partner_left گرفت', true);

    // ── سناریوی ۳: قطع ناگهانی اتصال ───────────────────────────────────────
    console.log('\n۳) قطع ناگهانی اتصال:');
    const c = track(new TestClient('C'));
    const d = track(new TestClient('D'));
    await authGuest(c);
    await authGuest(d);
    c.send({ type: 'join' });
    await c.expect('waiting');
    d.send({ type: 'join' });
    await Promise.all([c.expect('matched'), d.expect('matched')]);
    c.close();
    await d.expect('partner_left');
    check('با قطع شدن یک طرف، طرف دیگر partner_left گرفت', true);

    // ── سناریوی ۴: یک کاربر با خودش مچ نمی‌شود ─────────────────────────────
    console.log('\n۴) جلوگیری از مچ شدن کاربر با خودش:');
    const sameGuest = randomUUID();
    const e1 = track(new TestClient('E1'));
    const e2 = track(new TestClient('E2'));
    await authGuest(e1, sameGuest);
    await authGuest(e2, sameGuest);
    e1.send({ type: 'join' });
    await e1.expect('waiting');
    e2.send({ type: 'join' });
    const e2Waiting = await e2.expect('waiting');
    check('اتصال دوم همان کاربر به‌جای مچ شدن، وارد صف شد', e2Waiting.type === 'waiting');
    const replaced = await e1.expect('cancelled');
    check('اتصال اول همان کاربر از صف خارج شد', replaced.reason === 'replaced', JSON.stringify(replaced));
    const noSelfMatch = await e2.expectSilence('matched', 800);
    check('هیچ‌کدام با خودشان مچ نشدند', noSelfMatch);

    // ── سناریوی ۵: لغو انتظار ──────────────────────────────────────────────
    console.log('\n۵) لغو انتظار:');
    e2.send({ type: 'cancel' });
    const cancelled = await e2.expect('cancelled');
    check('پیام cancelled دریافت شد', cancelled.reason === 'user');
    const f = track(new TestClient('F'));
    await authGuest(f);
    f.send({ type: 'join' });
    const fWaiting = await f.expect('waiting');
    check('صف بعد از لغو خالی شده بود', fWaiting.type === 'waiting');
    f.send({ type: 'cancel' });
    await f.expect('cancelled');

    // ── سناریوی ۶: پیام‌های نامعتبر و ping ──────────────────────────────────
    console.log('\n۶) پروتکل:');
    f.send({ type: 'ping' });
    await f.expect('pong');
    check('ping/pong کار می‌کند', true);
    const g = track(new TestClient('G'));
    await g.opened;
    g.send({ type: 'join' });
    const notAuth = await g.expect('error');
    check('join بدون احراز هویت رد شد', notAuth.code === 'not_authenticated', JSON.stringify(notAuth));

    // ── سناریوی ۷: هجوم هم‌زمان (بررسی race condition) ─────────────────────
    console.log('\n۷) هجوم هم‌زمان کاربران:');
    // تعداد فرد انتخاب شده تا هم جفت‌شدن و هم «یک نفر در صف می‌ماند» بررسی شود
    const N = 21;
    const expectedPairs = (N - 1) / 2;
    const crowd = [];
    for (let i = 0; i < N; i += 1) crowd.push(track(new TestClient(`X${i}`)));
    await Promise.all(crowd.map((c) => authGuest(c)));
    // همه در یک tick پیام join می‌فرستند
    for (const c of crowd) c.send({ type: 'join' });

    const results = await Promise.all(
      crowd.map(async (c) => {
        try {
          const m = await c.expect('matched', 8000);
          return { client: c, room: m.room, token: m.token };
        } catch {
          return { client: c, room: null, token: null };
        }
      }),
    );

    const matched = results.filter((r) => r.room);
    check(`دقیقاً ${N - 1} نفر مچ شدند و ۱ نفر در صف ماند`, matched.length === N - 1, `${matched.length} نفر مچ شدند`);

    const byRoom = new Map();
    for (const r of matched) byRoom.set(r.room, (byRoom.get(r.room) ?? 0) + 1);
    const badRooms = [...byRoom.values()].filter((n) => n !== 2);
    check('هر اتاق دقیقاً ۲ نفر دارد (کسی دو بار مچ نشد)', badRooms.length === 0, `${badRooms.length} اتاق خراب`);
    check(`تعداد اتاق‌ها ${expectedPairs} است`, byRoom.size === expectedPairs, `${byRoom.size} اتاق`);

    const identities = matched.map((r) => decodeJwt(r.token).sub);
    check('همه‌ی هویت‌های LiveKit یکتا و ناشناس‌اند', new Set(identities).size === identities.length && identities.every((s) => /^anon_[0-9a-f]{16}$/.test(s)));

    // نفر باقی‌مانده باید هنوز waiting باشد و با آمدن یک نفر جدید مچ شود
    const leftover = results.find((r) => !r.room)?.client;
    const late = track(new TestClient('LATE'));
    await authGuest(late);
    late.send({ type: 'join' });
    const [lm1, lm2] = await Promise.all([leftover.expect('matched'), late.expect('matched')]);
    check('نفر باقی‌مانده با کاربر بعدی مچ شد', lm1.room === lm2.room);

    await sleep(200);
  } catch (err) {
    failures.push(String(err.message ?? err));
    console.log(`\n\x1b[31m✘ خطا: ${err.message ?? err}\x1b[0m`);
  } finally {
    for (const c of open) c.close();
  }

  console.log(`\n${'─'.repeat(52)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m✔ همه‌ی ${passed} بررسی با موفقیت انجام شد.\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m✘ ${failures.length} مورد ناموفق (از ${passed + failures.length}):\x1b[0m`);
  for (const f of failures) console.log(`   • ${f}`);
  console.log();
  process.exit(1);
}

main();
