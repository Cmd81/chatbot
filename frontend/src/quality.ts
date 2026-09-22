import { VideoPresets } from 'livekit-client';
import type { LocalVideoTrack, VideoPreset } from 'livekit-client';

/**
 * نردبان کیفیت — از پایین به بالا.
 * تطبیق فقط یک پله در هر بار بالا/پایین می‌رود تا تصویر نپرد.
 */
export const LADDER: readonly VideoPreset[] = [
  VideoPresets.h180, //  320×180  @ 160k  / 20fps
  VideoPresets.h360, //  640×360  @ 450k  / 20fps
  VideoPresets.h540, //  960×540  @ 800k  / 25fps
  VideoPresets.h720, // 1280×720  @ 1700k / 30fps
  VideoPresets.h1080, // 1920×1080 @ 3000k / 30fps
] as const;

export const IDX = { min: 0, low: 1, medium: 3, high: 4, max: LADDER.length - 1 } as const;

export type QualityMode = 'auto' | 'low' | 'medium' | 'high';

export const MODE_LABEL: Record<QualityMode, string> = {
  auto: 'خودکار',
  high: 'بالا',
  medium: 'متوسط',
  low: 'پایین',
};

export function isQualityMode(v: unknown): v is QualityMode {
  return v === 'auto' || v === 'low' || v === 'medium' || v === 'high';
}

/** برای حالت‌های دستی، پله‌ی ثابت. */
export function pinnedIndex(mode: Exclude<QualityMode, 'auto'>): number {
  return mode === 'high' ? IDX.high : mode === 'medium' ? IDX.medium : IDX.low;
}

export function presetAt(index: number): VideoPreset {
  const clamped = Math.min(Math.max(index, 0), LADDER.length - 1);
  return LADDER[clamped] as VideoPreset;
}

export function describe(preset: VideoPreset): string {
  return `${preset.width}×${preset.height} @ ${preset.encoding.maxFramerate}fps`;
}

/** کوچک‌ترین بُعد؛ روی موبایلِ عمودی عرض و ارتفاع جابه‌جا می‌شوند. */
function shortSide(w: number | undefined, h: number | undefined): number {
  if (!w || !h) return 0;
  return Math.min(w, h);
}

// ───────────────────────── مرحله ۲: شناخت دستگاه و شبکه ─────────────────────

interface NetworkInformation {
  effectiveType?: 'slow-2g' | '2g' | '3g' | '4g';
  downlink?: number;
  saveData?: boolean;
}
type NavigatorExtras = Navigator & { connection?: NetworkInformation; deviceMemory?: number };

export interface DeviceProfile {
  cores: number;
  memoryGb: number | null;
  effectiveType: string | null;
  downlinkMbps: number | null;
  saveData: boolean;
  startIndex: number;
}

/**
 * پله‌ی شروع بر اساس حدس‌های اولیه.
 *
 * این فقط یک «نقطه‌ی شروع» است، نه تصمیم نهایی — حلقه‌ی تطبیق بعداً بر اساس
 * اندازه‌گیری واقعی بالا و پایین می‌برد. Network Information API روی
 * Safari/iOS اصلاً وجود ندارد، پس هرگز به‌تنهایی به آن تکیه نمی‌کنیم.
 */
export function probeDevice(): DeviceProfile {
  const nav = navigator as NavigatorExtras;
  const conn = nav.connection;
  const cores = nav.hardwareConcurrency || 4;
  const memoryGb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const effectiveType = conn?.effectiveType ?? null;
  const downlinkMbps = typeof conn?.downlink === 'number' ? conn.downlink : null;
  const saveData = conn?.saveData === true;

  // عدد صریح لازم است، وگرنه TS نوع را روی literal همان پله قفل می‌کند
  let index: number = IDX.medium; // ۷۲۰p به‌عنوان شروع منطقی وقتی چیزی نمی‌دانیم

  if (saveData) {
    index = IDX.low;
  } else if (effectiveType === 'slow-2g' || effectiveType === '2g') {
    index = IDX.min;
  } else if (effectiveType === '3g') {
    index = IDX.low;
  } else if (effectiveType === '4g') {
    index = downlinkMbps !== null && downlinkMbps >= 5 ? IDX.high : IDX.medium;
  }

  // دستگاه ضعیف: انکود سنگین باعث افت فریم می‌شود که از وضوح پایین بدتر است.
  if (cores <= 2) index = Math.min(index, IDX.low);
  else if (cores <= 4) index = Math.min(index, IDX.medium);
  if (memoryGb !== null && memoryGb <= 2) index = Math.min(index, 2);

  return { cores, memoryGb, effectiveType, downlinkMbps, saveData, startIndex: index };
}

/**
 * سقف واقعی دوربین؛ از یک وبکم ۴۸۰p نباید ۱۰۸۰p خواست.
 *
 * مهم: باید از `getCapabilities()` خوانده شود و نه `getSettings()`.
 * `getSettings()` فقط وضوحِ همین لحظه را می‌گوید، پس اگر تماس را با ۵۴۰p
 * شروع کرده باشیم، سقف را اشتباهاً روی ۵۴۰p قفل می‌کرد و حالت خودکار
 * هرگز بالاتر نمی‌رفت.
 */
export function cameraCeiling(track: LocalVideoTrack): number {
  const mst = track.mediaStreamTrack;
  let side = 0;

  // getCapabilities روی بعضی مرورگرها (به‌ویژه Firefox) وجود ندارد
  if (typeof mst.getCapabilities === 'function') {
    try {
      const caps = mst.getCapabilities();
      side = shortSide(caps.width?.max, caps.height?.max);
    } catch {
      side = 0;
    }
  }
  if (!side) {
    const st = mst.getSettings();
    side = shortSide(st.width, st.height);
  }
  if (!side) return IDX.max;

  let max = 0;
  for (let i = 0; i < LADDER.length; i += 1) {
    const p = LADDER[i] as VideoPreset;
    if (Math.min(p.width, p.height) <= side + 8) max = i; // ۸ پیکسل ارفاق
  }
  return max;
}

// ───────────────────────── اعمال کیفیت روی ترک زنده ─────────────────────────

/**
 * تغییر کیفیت **بدون ری‌استارت دوربین**: فقط پارامترهای انکودر عوض می‌شوند.
 * ری‌استارت کردن دوربین در هر پله باعث یک فریم سیاه و پرش تصویر می‌شد.
 * `scaleResolutionDownBy` وضوح ارسالی را از روی همان تصویر ورودی کم می‌کند.
 */
export async function applyEncoding(track: LocalVideoTrack, preset: VideoPreset): Promise<void> {
  const sender = track.sender;
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) return;

  const s = track.mediaStreamTrack.getSettings();
  const captureSide = shortSide(s.width, s.height);
  const targetSide = Math.min(preset.width, preset.height);
  const scale = captureSide > 0 ? Math.max(1, captureSide / targetSide) : 1;

  for (const enc of params.encodings) {
    enc.maxBitrate = preset.encoding.maxBitrate;
    enc.maxFramerate = preset.encoding.maxFramerate;
    enc.scaleResolutionDownBy = scale;
  }
  await sender.setParameters(params);
}

/**
 * اعمال کامل یک پله.
 *
 * `scaleResolutionDownBy` فقط می‌تواند وضوح را **کم** کند. پس برای رفتن به
 * پله‌ای بالاتر از وضوح فعلیِ دوربین، باید دوربین را با وضوح جدید ری‌استارت
 * کرد. این کار یک پرش کوتاه دارد، برای همین فقط هنگام بالا رفتن و حداکثر هر
 * ۳۰ ثانیه یک‌بار اتفاق می‌افتد — پایین آمدن هیچ‌وقت ری‌استارت نمی‌کند.
 */
export async function applyPreset(track: LocalVideoTrack, preset: VideoPreset): Promise<void> {
  const st = track.mediaStreamTrack.getSettings();
  const captureSide = shortSide(st.width, st.height);
  const targetSide = Math.min(preset.width, preset.height);

  if (targetSide > captureSide + 8) {
    try {
      await track.restartTrack({
        resolution: preset.resolution,
        frameRate: preset.encoding.maxFramerate,
        facingMode: 'user',
      });
    } catch {
      // دوربین بیشتر از این نمی‌تواند؛ با همان وضوح فعلی ادامه می‌دهیم.
    }
  }
  await applyEncoding(track, preset);
}

// ───────────────────────── مرحله ۳: حلقه‌ی تطبیق زنده ───────────────────────

export interface QualitySample {
  width: number;
  height: number;
  fps: number;
  index: number;
  reason: 'bandwidth' | 'cpu' | 'none' | 'other';
}

export interface AdaptiveOptions {
  /** پایین‌ترین و بالاترین پله‌ی مجاز */
  min: number;
  max: number;
  start: number;
  onSample(sample: QualitySample): void;
}

const SAMPLE_MS = 5_000;
/** برای بالا رفتن، ۶ نمونه‌ی پیاپی سالم لازم است (~۳۰ ثانیه). */
const UP_AFTER_SAMPLES = 6;

/**
 * کنترلر تطبیق.
 *
 * قاعده‌ی هیسترزیس: **پایین سریع، بالا آهسته.** بدون این، کیفیت مدام بالا و
 * پایین می‌پرد که از کیفیت پایینِ ثابت هم آزاردهنده‌تر است.
 *
 * تفکیک `bandwidth` از `cpu` مهم است: وقتی گلوگاه CPU است، کم کردن بیت‌ریت
 * کمکی نمی‌کند و باید بار انکود کم شود.
 */
export class AdaptiveQuality {
  private timer: ReturnType<typeof setInterval> | null = null;
  private index: number;
  private stable = 0;
  private cpuCeiling: number | null = null;
  private busy = false;

  constructor(
    private readonly track: LocalVideoTrack,
    private readonly opts: AdaptiveOptions,
  ) {
    this.index = Math.min(Math.max(opts.start, opts.min), opts.max);
  }

  get currentIndex(): number {
    return this.index;
  }

  /** پله‌ی شروع را اعمال می‌کند و بعد حلقه را راه می‌اندازد. */
  async start(): Promise<void> {
    if (this.timer) return;
    await applyPreset(this.track, presetAt(this.index));
    this.timer = setInterval(() => void this.tick(), SAMPLE_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private effectiveMax(): number {
    return this.cpuCeiling === null ? this.opts.max : Math.min(this.opts.max, this.cpuCeiling);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const stats = (await this.track.getSenderStats())[0];
      if (!stats) return;

      const raw = stats.qualityLimitationReason ?? 'none';
      const reason: QualitySample['reason'] =
        raw === 'bandwidth' || raw === 'cpu' || raw === 'none' ? raw : 'other';

      this.opts.onSample({
        width: stats.frameWidth,
        height: stats.frameHeight,
        fps: Math.round(stats.framesPerSecond ?? 0),
        index: this.index,
        reason,
      });

      if (reason === 'cpu') {
        // گلوگاه پردازنده: سقف را همین‌جا قفل می‌کنیم تا دوباره بالا نرود.
        this.stable = 0;
        if (this.cpuCeiling === null) {
          this.cpuCeiling = Math.max(this.opts.min, this.index - 1);
          try {
            await this.track.prioritizePerformance();
          } catch {
            /* روی بعضی مرورگرها پشتیبانی نمی‌شود */
          }
        }
        await this.step(-1);
        return;
      }

      if (reason === 'bandwidth') {
        this.stable = 0;
        await this.step(-1);
        return;
      }

      // وضعیت سالم — ولی فقط وقتی بالا می‌رویم که فریم هم واقعاً برقرار باشد.
      const target = presetAt(this.index).encoding.maxFramerate ?? 30;
      const healthyFps = (stats.framesPerSecond ?? 0) >= target * 0.7;
      this.stable = healthyFps ? this.stable + 1 : 0;

      if (this.stable >= UP_AFTER_SAMPLES) {
        this.stable = 0;
        await this.step(+1);
      }
    } catch {
      /* خطای موقتی در خواندن آمار نباید حلقه را بکشد */
    } finally {
      this.busy = false;
    }
  }

  private async step(delta: number): Promise<void> {
    const next = Math.min(Math.max(this.index + delta, this.opts.min), this.effectiveMax());
    if (next === this.index) return;
    this.index = next;
    await applyPreset(this.track, presetAt(next));
  }
}
