/**
 * تست منطق گفتگو (بدون مرورگر).
 *   cd frontend && npm run test:chat
 */
import {
  ChatStore,
  MAX_MESSAGES,
  MAX_TEXT_LENGTH,
  SendLimiter,
  TYPING_PING_MS,
  TypingThrottle,
  decode,
  encode,
  encodeTyping,
  sanitize,
} from '../frontend/src/chat';

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

console.log('\n🧪 تست گفتگوی متنی\n');

console.log('۱) پاک‌سازی متن:');
check('متن ساده سالم می‌ماند', sanitize('سلام دنیا') === 'سلام دنیا');
check('فاصله‌های ابتدا و انتها حذف می‌شوند', sanitize('  سلام  ') === 'سلام');
check('رشته‌ی خالی رد می‌شود', sanitize('   ') === null);
check('ورودی غیررشته‌ای رد می‌شود', sanitize(42) === null && sanitize(null) === null && sanitize({}) === null);
check('خط جدید حفظ می‌شود', sanitize('خط اول\nخط دوم') === 'خط اول\nخط دوم');
check('کاراکترهای کنترلی حذف می‌شوند', sanitize('س\u0007ل\u0000ام') === 'سلام');
check(
  'کاراکترهای جهت‌دهی دوطرفه حذف می‌شوند (جعل ظاهر متن)',
  sanitize('سلام‮دنیا') === 'سلامدنیا',
);
check(`متن بلندتر از ${MAX_TEXT_LENGTH} بریده می‌شود`, sanitize('a'.repeat(900))?.length === MAX_TEXT_LENGTH);

console.log('\n۲) بسته‌بندی روی کانال داده:');
{
  const round = decode(encode('abc', 'سلام'));
  check('رفت و برگشت سالم است', round?.kind === 'msg' && round.id === 'abc' && round.text === 'سلام');
}
check('بسته‌ی خراب رد می‌شود', decode(new TextEncoder().encode('}{ not json')) === null);
check('نوع ناشناخته رد می‌شود', decode(new TextEncoder().encode('{"t":"evil","text":"x"}')) === null);
check('بسته‌ی بدون متن رد می‌شود', decode(new TextEncoder().encode('{"t":"msg","id":"a"}')) === null);
check('متن دریافتی هم پاک‌سازی می‌شود', decode(encode('a', 'x‭y'))?.text === 'xy');
{
  const noisy = decode(new TextEncoder().encode(JSON.stringify({ t: 'msg', id: 'x'.repeat(200), text: 'hi' })));
  check('شناسه‌ی بیش از حد بلند با شناسه‌ی تازه جایگزین می‌شود', noisy?.kind === 'msg' && noisy.id.length <= 64);
}
{
  const html = decode(encode('a', '<img src=x onerror=alert(1)>'));
  check(
    'HTML به‌عنوان متن خام می‌ماند (در UI با textContent درج می‌شود)',
    html?.kind === 'msg' && html.text === '<img src=x onerror=alert(1)>',
  );
}

console.log('\n۲.۱) بسته‌ی «در حال نوشتن»:');
{
  const on = decode(encodeTyping(true));
  const off = decode(encodeTyping(false));
  check('روشن و خاموش هر دو رمزگشایی می‌شوند', on?.kind === 'typing' && on.on === true && off?.kind === 'typing' && off.on === false);
  check('بسته‌ی تایپ هیچ متنی حمل نمی‌کند', !JSON.parse(new TextDecoder().decode(encodeTyping(true))).text);
  const weird = decode(new TextEncoder().encode('{"t":"typing"}'));
  check('نبود فیلد on یعنی خاموش', weird?.kind === 'typing' && weird.on === false);
  const notBool = decode(new TextEncoder().encode('{"t":"typing","on":"yes"}'));
  check('مقدار غیربولی روشن حساب نمی‌شود', notBool?.kind === 'typing' && notBool.on === false);
}

console.log('\n۳) نگهدارنده‌ی پیام‌ها:');
{
  const store = new ChatStore();
  check('پیام اضافه می‌شود', store.add({ id: 'a', text: 'یک', mine: true })?.text === 'یک');
  check('شناسه‌ی تکراری اضافه نمی‌شود', store.add({ id: 'a', text: 'دوباره', mine: false }) === null);
  check('تعداد درست است', store.size === 1);

  for (let i = 0; i < MAX_MESSAGES + 50; i += 1) store.add({ id: `k${i}`, text: `m${i}`, mine: false });
  check(`سقف ${MAX_MESSAGES} پیام رعایت می‌شود`, store.size === MAX_MESSAGES, String(store.size));
  check('قدیمی‌ترین‌ها کنار رفته‌اند', store.messages[store.size - 1]?.text === `m${MAX_MESSAGES + 49}`);
  check(
    'شناسه‌ی پیامِ هرس‌شده دوباره قابل استفاده است (نشت Set نداریم)',
    store.add({ id: 'k0', text: 'دوباره آمد', mine: false }) !== null,
  );

  store.clear();
  check('clear همه‌چیز را پاک می‌کند', store.size === 0 && store.messages.length === 0);
  check('بعد از clear شناسه‌های قبلی دوباره پذیرفته می‌شوند', store.add({ id: 'a', text: 'باز', mine: true }) !== null);
}

console.log('\n۴) محدودیت ارسال:');
{
  const limiter = new SendLimiter(3, 1000);
  const t0 = 10_000;
  check('سه پیام اول مجازند', [0, 1, 2].every((i) => limiter.allow(t0 + i)));
  check('پیام چهارم در همان بازه رد می‌شود', !limiter.allow(t0 + 3));
  check('بعد از پایان بازه دوباره مجاز است', limiter.allow(t0 + 1500));
  limiter.reset();
  check('reset شمارنده را صفر می‌کند', limiter.allow(t0 + 1600) && limiter.allow(t0 + 1601));
}

console.log('\n۵) تنظیم نرخ «در حال نوشتن»:');
{
  const throttle = new TypingThrottle();
  const t0 = 50_000;
  check('اولین ضربه بسته می‌فرستد', throttle.shouldSend(t0));
  check('ضربه‌های پشت سر هم بسته نمی‌فرستند', !throttle.shouldSend(t0 + 100) && !throttle.shouldSend(t0 + 500));
  check(`بعد از ${TYPING_PING_MS}ms دوباره می‌فرستد`, throttle.shouldSend(t0 + TYPING_PING_MS));
  throttle.reset();
  check('reset اجازه‌ی ارسال فوری می‌دهد', throttle.shouldSend(t0 + TYPING_PING_MS + 10));
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
