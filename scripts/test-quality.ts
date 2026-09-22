/**
 * تست منطق انتخاب کیفیت (بدون مرورگر).
 *
 *   npx tsx scripts/test-quality.ts
 */
import { IDX, LADDER, cameraCeiling, pinnedIndex, presetAt, probeDevice } from '../frontend/src/quality';

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

type Conn = { effectiveType?: string; downlink?: number; saveData?: boolean };

/**
 * در Node ۲۲ خاصیت `navigator` فقط getter دارد، پس انتساب ساده بی‌اثر است
 * (و در ماژول CJS حتی خطا هم نمی‌دهد). باید با defineProperty جایگزین شود.
 */
function withNavigator(nav: { hardwareConcurrency?: number; deviceMemory?: number; connection?: Conn }): number {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      hardwareConcurrency: nav.hardwareConcurrency ?? 8,
      deviceMemory: nav.deviceMemory,
      connection: nav.connection,
    },
    configurable: true,
    writable: true,
  });
  return probeDevice().startIndex;
}

// اگر جایگزینی کار نکند، همه‌ی تست‌ها بی‌معنا می‌شوند — همین‌جا بررسی شود.
withNavigator({ hardwareConcurrency: 7 });
if ((navigator as { hardwareConcurrency?: number }).hardwareConcurrency !== 7) {
  console.error('هارنس تست نتوانست navigator را جایگزین کند؛ نتایج بی‌اعتبارند.');
  process.exit(2);
}

function fakeTrack(caps: { width?: number; height?: number } | null, settings = { width: 640, height: 480 }) {
  return {
    mediaStreamTrack: {
      getCapabilities: caps
        ? () => ({ width: { max: caps.width }, height: { max: caps.height } })
        : undefined,
      getSettings: () => settings,
    },
  } as never;
}

console.log('\n🧪 تست منطق کیفیت\n');

console.log('۱) نردبان:');
check('پنج پله دارد و صعودی است', LADDER.length === 5 && LADDER.every((p, i) => i === 0 || p.height > (LADDER[i - 1] as { height: number }).height));
check('پله‌های نام‌گذاری‌شده درست‌اند', presetAt(IDX.low).height === 360 && presetAt(IDX.medium).height === 720 && presetAt(IDX.high).height === 1080);
check('presetAt خارج از بازه را کلمپ می‌کند', presetAt(-5) === LADDER[0] && presetAt(99) === LADDER[4]);
check('pinnedIndex نگاشت درست دارد', pinnedIndex('low') === IDX.low && pinnedIndex('medium') === IDX.medium && pinnedIndex('high') === IDX.high);

console.log('\n۲) پروفایل شبکه:');
check('saveData → پایین‌ترین حالت کاربرپسند', withNavigator({ connection: { saveData: true, effectiveType: '4g', downlink: 50 } }) === IDX.low);
check('2g → کمترین پله', withNavigator({ connection: { effectiveType: '2g' } }) === IDX.min);
check('3g → ۳۶۰p', withNavigator({ connection: { effectiveType: '3g' } }) === IDX.low);
check('4g کند (۲ مگابیت) → ۷۲۰p', withNavigator({ connection: { effectiveType: '4g', downlink: 2 } }) === IDX.medium);
check('4g سریع (۲۰ مگابیت) → ۱۰۸۰p', withNavigator({ connection: { effectiveType: '4g', downlink: 20 } }) === IDX.high);
check('بدون Network API (مثل iOS) → شروع محافظه‌کارانه از ۷۲۰p', withNavigator({}) === IDX.medium);

console.log('\n۳) توان دستگاه:');
check('۲ هسته سقف را روی ۳۶۰p می‌آورد', withNavigator({ hardwareConcurrency: 2, connection: { effectiveType: '4g', downlink: 50 } }) === IDX.low);
check('۴ هسته سقف را روی ۷۲۰p می‌آورد', withNavigator({ hardwareConcurrency: 4, connection: { effectiveType: '4g', downlink: 50 } }) === IDX.medium);
check('۲ گیگ رم سقف را روی ۵۴۰p می‌آورد', withNavigator({ hardwareConcurrency: 8, deviceMemory: 2, connection: { effectiveType: '4g', downlink: 50 } }) === 2);
check('دستگاه قوی + شبکه‌ی خوب → ۱۰۸۰p', withNavigator({ hardwareConcurrency: 8, deviceMemory: 8, connection: { effectiveType: '4g', downlink: 30 } }) === IDX.high);
check('شبکه‌ی ضعیف بر دستگاه قوی غالب است', withNavigator({ hardwareConcurrency: 16, deviceMemory: 16, connection: { effectiveType: '3g' } }) === IDX.low);

console.log('\n۴) سقف دوربین:');
check('دوربین ۱۰۸۰p → بالاترین پله', cameraCeiling(fakeTrack({ width: 1920, height: 1080 })) === IDX.high);
check('وبکم ۴۸۰p → حداکثر ۳۶۰p', cameraCeiling(fakeTrack({ width: 640, height: 480 })) === IDX.low);
check('دوربین ۷۲۰p → حداکثر ۷۲۰p', cameraCeiling(fakeTrack({ width: 1280, height: 720 })) === IDX.medium);
check('دوربین عمودی (۷۲۰×۱۲۸۰) هم درست خوانده می‌شود', cameraCeiling(fakeTrack({ width: 720, height: 1280 })) === IDX.medium);
check(
  'نبود getCapabilities → سقف از settings حدس زده می‌شود',
  cameraCeiling(fakeTrack(null, { width: 1280, height: 720 })) === IDX.medium,
);

console.log(`\n${'─'.repeat(52)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m✔ همه‌ی ${passed} بررسی با موفقیت انجام شد.\x1b[0m\n`);
  process.exit(0);
}
console.log(`\x1b[31m✘ ${failures.length} مورد ناموفق:\x1b[0m`);
for (const f of failures) console.log(`   • ${f}`);
console.log();
process.exit(1);
