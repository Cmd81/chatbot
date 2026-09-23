/**
 * تست منطق چت داخل ربات (بدون تلگرام).
 *   cd backend && npm run test:botchat
 */
import { BotMatchmaker, RelayMap } from '../backend/src/telegram/chatMatch';

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32m✔\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n🧪 تست چت داخل ربات\n');

console.log('۱) مچ شدن:');
{
  const mm = new BotMatchmaker();
  const first = mm.join(101);
  check('نفر اول وارد صف می‌شود', first.status === 'queued' && first.position === 1);
  check('هنوز در چت نیست', !mm.isChatting(101) && mm.isWaiting(101));

  const again = mm.join(101);
  check('زدن دوباره‌ی دکمه او را دو بار در صف نمی‌گذارد', again.status === 'already_queued');

  const second = mm.join(202);
  check('نفر دوم مچ می‌شود', second.status === 'matched' && second.partner === 101);
  check('هر دو طرف یکدیگر را می‌بینند', mm.partnerOf(101) === 202 && mm.partnerOf(202) === 101);
  check('صف خالی شد', mm.stats().waiting === 0 && mm.stats().chats === 1);

  const third = mm.join(101);
  check('کسی که در چت است دوباره وارد صف نمی‌شود', third.status === 'already_chatting' && third.partner === 202);
}

console.log('\n۲) ترتیب و طول صف:');
{
  const mm = new BotMatchmaker();
  // چون مچ فوری است، به‌محض رسیدن نفر دوم جفت می‌شوند؛
  // پس صف هیچ‌وقت بیش از یک نفر نمی‌شود.
  const r1 = mm.join(1);
  const r2 = mm.join(2);
  check('نفر اول در صف، نفر دوم بلافاصله مچ', r1.status === 'queued' && r2.status === 'matched');
  check('صف بعد از مچ خالی است', mm.stats().waiting === 0);

  const r3 = mm.join(3);
  const r4 = mm.join(4);
  check('جفت دوم مستقل ساخته می‌شود', r3.status === 'queued' && r4.status === 'matched' && r4.partner === 3);

  // ناوردا: هر چقدر هم آدم بیاید، طول صف از یک بیشتر نمی‌شود
  const mm2 = new BotMatchmaker();
  let maxQueue = 0;
  for (let id = 1; id <= 50; id += 1) {
    mm2.join(id);
    maxQueue = Math.max(maxQueue, mm2.stats().waiting);
  }
  check('با ۵۰ نفر هم صف هرگز از ۱ بیشتر نمی‌شود', maxQueue === 1, `بیشینه ${maxQueue}`);
  check('۲۵ چت ساخته شد و کسی جا نماند', mm2.stats().chats === 25 && mm2.stats().waiting === 0);

  // قدیمی‌ترین منتظر است که مچ می‌شود
  const mm3 = new BotMatchmaker();
  mm3.join(7);
  const late = mm3.join(9);
  check('تازه‌وارد با نفرِ منتظر مچ می‌شود، نه با خودش', late.status === 'matched' && late.partner === 7);
}

console.log('\n۳) پایان و لغو:');
{
  const mm = new BotMatchmaker();
  mm.join(10);
  check('لغو از صف کار می‌کند', mm.cancel(10) === true && !mm.isWaiting(10));
  check('لغو دوباره false می‌دهد', mm.cancel(10) === false);

  mm.join(10);
  mm.join(20);
  const partner = mm.end(10);
  check('پایان چت شناسه‌ی طرف مقابل را برمی‌گرداند', partner === 20);
  check('هر دو طرف آزاد می‌شوند', !mm.isChatting(10) && !mm.isChatting(20));
  check('پایانِ دوباره null می‌دهد', mm.end(10) === null);
  check('شمارش چت‌ها صفر شد', mm.stats().chats === 0);

  mm.join(10);
  mm.join(20);
  const s = mm.sessionOf(10);
  s?.relay.remember(10, 5, 20, 7);
  mm.end(20);
  // نگاشت عمداً زنده می‌ماند: بدون آن «پاک کردن کل گفتگو» غیرممکن می‌شد.
  check('نگاشت پیام‌ها بعد از پایان چت زنده می‌ماند', (s?.relay.size ?? 0) > 0);
  check('و فقط با پاک کردن گفتگو از بین می‌رود', (mm.forgetRecent(10), s?.relay.size) === 0);
}

console.log('\n۴) «نفر بعدی»:');
{
  const mm = new BotMatchmaker();
  mm.join(1);
  mm.join(2);
  mm.end(1); // ۱ دکمه‌ی نفر بعدی را زد
  const again = mm.join(1);
  check('بعد از «نفر بعدی» دوباره وارد صف می‌شود', again.status === 'queued');
  const third = mm.join(3);
  check('با نفر تازه مچ می‌شود', third.status === 'matched' && third.partner === 1);
  check('طرف قبلی آزاد است و در صف نیست', !mm.isChatting(2) && !mm.isWaiting(2));
}

console.log('\n۵) نگاشت پاسخ‌ها:');
{
  const relay = new RelayMap(6);
  relay.remember(100, 11, 200, 21);
  check('از چت فرستنده به گیرنده پیدا می‌شود', relay.lookup(100, 11) === 21);
  check('از چت گیرنده به فرستنده هم پیدا می‌شود', relay.lookup(200, 21) === 11);
  check('پیام ناشناخته undefined می‌دهد', relay.lookup(100, 99) === undefined);
  check('شناسه‌ی یکسان در چت دیگر قاطی نمی‌شود', relay.lookup(200, 11) === undefined);

  for (let i = 0; i < 20; i += 1) relay.remember(100, 1000 + i, 200, 2000 + i);
  check('سقف حافظه رعایت می‌شود', relay.size <= 6, String(relay.size));
  check('تازه‌ترین نگاشت باقی می‌ماند', relay.lookup(100, 1019) === 2019);
  check('قدیمی‌ترین نگاشت کنار رفته', relay.lookup(100, 11) === undefined);

  relay.clear();
  check('clear همه را پاک می‌کند', relay.size === 0 && relay.lookup(100, 1019) === undefined);
}

console.log('\n۶) جهت پیام — پایه‌ی امنیتِ حذف:');
{
  const relay = new RelayMap();
  // کاربر ۱۰۰ پیام ۱۱ را فرستاد؛ ربات آن را در چت ۲۰۰ با شناسه‌ی ۲۱ کپی کرد
  relay.remember(100, 11, 200, 21);

  check('پیام خودِ فرستنده «اصل» است', relay.isOriginal(100, 11) === true);
  check('کپیِ ربات در چت گیرنده «اصل» نیست', relay.isOriginal(200, 21) === false);
  check('پیام ناشناخته اصل حساب نمی‌شود', relay.isOriginal(100, 999) === false);

  // سناریوی سوءاستفاده: گیرنده روی پیامِ رسیده /del بزند
  // باید رد شود، وگرنه می‌توانست پیام طرف مقابل را از چت او پاک کند.
  check(
    'گیرنده نمی‌تواند پیام طرف مقابل را حذف کند',
    relay.isOriginal(200, 21) === false && relay.lookup(200, 21) === 11,
  );

  // جهت در دو طرف قاطی نمی‌شود
  relay.remember(200, 30, 100, 40);
  check('هر طرف فقط پیام‌های خودش را اصل دارد', relay.isOriginal(200, 30) === true && relay.isOriginal(100, 40) === false);
}

console.log('\n۷) جدا بودن کاربران:');
{
  const mm = new BotMatchmaker();
  mm.join(1);
  mm.join(2);
  mm.join(3);
  mm.join(4);
  check('دو چت مستقل ساخته شد', mm.stats().chats === 2 && mm.stats().matches === 2);
  check('هیچ‌کس با فرد اشتباهی جفت نشد', mm.partnerOf(1) === 2 && mm.partnerOf(3) === 4);
  mm.end(1);
  check('پایان یک چت به چت دیگر کاری ندارد', mm.partnerOf(3) === 4 && mm.stats().chats === 1);
}

console.log('\n۸) پاک کردن کل گفتگو بعد از پایان چت:');
{
  const mm = new BotMatchmaker();
  mm.join(500);
  mm.join(600);
  const session = mm.sessionOf(500)!;

  // چند پیام رد و بدل شده: ۵۰۰ دو تا فرستاده، ۶۰۰ یکی
  session.relay.remember(500, 1, 600, 101);
  session.relay.remember(500, 2, 600, 102);
  session.relay.remember(600, 50, 500, 900);

  mm.end(500);
  check('بعد از پایان چت، گفتگو هنوز قابل پاک کردن است', mm.recentOf(500) !== null);
  check('طرف مقابل هم به همان گفتگو دسترسی دارد', mm.recentOf(600) !== null);
  check('هر دو به یک رکورد اشاره می‌کنند', mm.recentOf(500) === mm.recentOf(600));

  const byChat = mm.recentOf(500)!.relay.idsByChat();
  const mine = [...(byChat.get(500) ?? [])].sort((a, b) => a - b);
  const theirs = [...(byChat.get(600) ?? [])].sort((a, b) => a - b);
  check('همه‌ی پیام‌های چت اول فهرست می‌شوند', JSON.stringify(mine) === JSON.stringify([1, 2, 900]), JSON.stringify(mine));
  check('همه‌ی پیام‌های چت دوم فهرست می‌شوند', JSON.stringify(theirs) === JSON.stringify([50, 101, 102]), JSON.stringify(theirs));

  mm.forgetRecent(600);
  check('بعد از پاک کردن، رکورد برای هر دو طرف می‌رود', mm.recentOf(500) === null && mm.recentOf(600) === null);
}

console.log('\n۹) چت تازه، رکورد قبلی را جایگزین می‌کند:');
{
  const mm = new BotMatchmaker();
  mm.join(1); mm.join(2);
  mm.sessionOf(1)!.relay.remember(1, 10, 2, 20);
  mm.end(1);
  const first = mm.recentOf(1);

  mm.join(1); mm.join(3);
  mm.sessionOf(1)!.relay.remember(1, 11, 3, 30);
  mm.end(1);
  const second = mm.recentOf(1);

  check('آخرین گفتگو جایگزین قبلی می‌شود', second !== null && second !== first);
  check('رکورد تازه مربوط به طرف جدید است', second!.a === 1 && second!.b === 3);
  check('طرف قدیمی دیگر دسترسی ندارد', mm.recentOf(2) !== null && mm.recentOf(2) === first);
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
