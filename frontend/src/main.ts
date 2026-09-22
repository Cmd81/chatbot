import './styles.css';
import type { LocalAudioTrack, LocalTrack, LocalVideoTrack, RemoteTrack } from 'livekit-client';
import {
  CallSession,
  QUALITY_PRESETS,
  acquireLocalTracks,
  findAudioTrack,
  findVideoTrack,
  mediaErrorMessage,
  resolveCodec,
  resolveQuality,
  stopTracks,
} from './call';
import { Signal } from './signal';
import type { ServerMessage } from './protocol';
import { haptic, initTelegram, insideTelegram, setClosingConfirmation, tg } from './tg';

type Screen = 'loading' | 'intro' | 'permission' | 'waiting' | 'call' | 'ended' | 'error';

const GUEST_KEY = 'anon-video:guest-id';

// تنظیمات قابل آزمایش از طریق نشانی:
//   ?q=low|medium|high   کیفیت ویدیو (پیش‌فرض high = ۷۲۰p)
//   ?codec=vp9|h264      کدک (پیش‌فرض vp8 برای بیشترین سازگاری)
//   ?relay=1             اجبار عبور از TURN
const params = new URLSearchParams(location.search);
const forceRelay = params.get('relay') === '1';
const quality = resolveQuality(params.get('q'));
const codec = resolveCodec(params.get('codec'));
const preset = QUALITY_PRESETS[quality];
console.info(
  `[anon-video] کیفیت: ${preset.width}×${preset.height} @ ${Math.round(preset.encoding.maxBitrate / 1000)}kbps / ${preset.encoding.maxFramerate}fps — کدک: ${codec}`,
);

// ── عناصر DOM ───────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element #${id} not found`);
  return el as T;
};

const app = $('app');
const remoteVideo = $<HTMLVideoElement>('remoteVideo');
const remotePlaceholder = $('remotePlaceholder');
const localVideo = $<HTMLVideoElement>('localVideo');
const waitPreview = $<HTMLVideoElement>('waitPreview');
const netBadge = $('netBadge');
const toastEl = $('toast');
const micIcon = $('micIcon');
const camIcon = $('camIcon');
const btnMic = $<HTMLButtonElement>('btnMic');
const btnCam = $<HTMLButtonElement>('btnCam');

// ── وضعیت ───────────────────────────────────────────────────────────────────
let screen: Screen = 'loading';
let authenticated = false;
let queued = false; // کاربر می‌خواهد در صف باشد (برای join دوباره بعد از reconnect)
let localTracks: LocalTrack[] = [];
let call: CallSession | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnecting = false;
let rtcReconnecting = false;
let poorNetwork = false;

function updateNetBadge(): void {
  if (wsReconnecting || rtcReconnecting) {
    netBadge.textContent = 'در حال اتصال مجدد…';
    netBadge.hidden = false;
  } else if (poorNetwork) {
    netBadge.textContent = 'کیفیت شبکه ضعیف است';
    netBadge.hidden = false;
  } else {
    netBadge.hidden = true;
  }
}

function setScreen(next: Screen): void {
  screen = next;
  app.dataset.screen = next;
  setClosingConfirmation(next === 'call' || next === 'waiting');
}

function toast(message: string, ms = 4000): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, ms);
}

function showError(title: string, text: string): void {
  $('errorTitle').textContent = title;
  $('errorText').textContent = text;
  setScreen('error');
  haptic('error');
}

function showEnded(title: string, text: string, icon = '📴'): void {
  $('endedTitle').textContent = title;
  $('endedText').textContent = text;
  $('endedIcon').textContent = icon;
  setScreen('ended');
}

// ── سیگنالینگ ───────────────────────────────────────────────────────────────
const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

const signal = new Signal(wsUrl, {
  onOpen: () => {
    authenticated = false;
    if (insideTelegram && tg) {
      signal.send({ type: 'auth', mode: 'telegram', initData: tg.initData });
    } else {
      let guestId: string | undefined;
      try {
        guestId = localStorage.getItem(GUEST_KEY) ?? undefined;
      } catch {
        guestId = undefined;
      }
      signal.send(guestId ? { type: 'auth', mode: 'guest', guestId } : { type: 'auth', mode: 'guest' });
    }
  },
  onMessage: handleServerMessage,
  onClose: (willRetry) => {
    authenticated = false;
    if (screen === 'waiting') {
      toast('اتصال به سرور قطع شد؛ در حال اتصال مجدد…');
    } else if (screen === 'call') {
      wsReconnecting = true;
      updateNetBadge();
    } else if (!willRetry) {
      showError('اتصال قطع شد', 'ارتباط با سرور برقرار نیست. اینترنت خود را بررسی کنید.');
    }
  },
});

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'ready': {
      authenticated = true;
      if (msg.guestId) {
        try {
          localStorage.setItem(GUEST_KEY, msg.guestId);
        } catch {
          /* حالت مرور خصوصی */
        }
      }
      if (screen === 'loading') setScreen('intro');
      if (screen === 'waiting') toastEl.hidden = true;
      if (wsReconnecting) {
        wsReconnecting = false;
        updateNetBadge();
      }
      // اگر وسط انتظار اتصال قطع شده بود، دوباره وارد صف می‌شویم.
      if (queued && (screen === 'waiting' || screen === 'permission')) signal.send({ type: 'join' });
      break;
    }

    case 'waiting':
      queued = true;
      setScreen('waiting');
      break;

    case 'matched':
      queued = false;
      void startCall(msg.url, msg.token);
      break;

    case 'partner_left':
      queued = false;
      void endCall();
      showEnded('طرف مقابل تماس را ترک کرد', 'می‌توانید یک تماس جدید شروع کنید.', '👋');
      haptic('warning');
      break;

    case 'call_ended':
      queued = false;
      break;

    case 'cancelled':
      queued = false;
      if (msg.reason === 'replaced') {
        showEnded('از صف خارج شدید', 'همین حساب از یک دستگاه یا تب دیگر وارد صف شد.', 'ℹ️');
      } else if (screen === 'waiting') {
        setScreen('intro');
      }
      break;

    case 'error':
      queued = false;
      handleServerError(msg.code, msg.message);
      break;

    default:
      break;
  }
}

function handleServerError(code: string, message: string): void {
  if (code === 'auth_failed' || code === 'guest_disabled') {
    showError('احراز هویت ناموفق', message);
    return;
  }
  if (screen === 'waiting' || screen === 'permission') {
    releaseMedia();
    showError('خطا', message);
    return;
  }
  toast(message);
}

// ── رسانه ───────────────────────────────────────────────────────────────────
function releaseMedia(): void {
  stopTracks(localTracks);
  localTracks = [];
  waitPreview.srcObject = null;
  localVideo.srcObject = null;
}

async function ensureMedia(): Promise<boolean> {
  const alive = localTracks.length > 0 && localTracks.every((t) => t.mediaStreamTrack.readyState === 'live');
  if (alive) return true;
  releaseMedia();
  setScreen('permission');
  try {
    localTracks = await acquireLocalTracks(quality);
  } catch (err) {
    showError('دسترسی به دوربین', mediaErrorMessage(err));
    return false;
  }
  const video = findVideoTrack(localTracks);
  if (video) {
    video.attach(waitPreview);
    video.attach(localVideo);
  }
  syncControlIcons();
  return true;
}

function syncControlIcons(): void {
  const audio = findAudioTrack(localTracks) as LocalAudioTrack | null;
  const video = findVideoTrack(localTracks) as LocalVideoTrack | null;
  const micOff = !audio || audio.isMuted;
  const camOff = !video || video.isMuted;
  btnMic.dataset.off = String(micOff);
  btnCam.dataset.off = String(camOff);
  micIcon.textContent = micOff ? '🔇' : '🎙️';
  camIcon.textContent = camOff ? '🚫' : '📷';
  localVideo.style.visibility = camOff ? 'hidden' : 'visible';
}

// ── تماس ────────────────────────────────────────────────────────────────────
async function startCall(url: string, token: string): Promise<void> {
  if (call) await endCall();
  remoteVideo.srcObject = null;
  remotePlaceholder.hidden = false;
  rtcReconnecting = false;
  poorNetwork = false;
  updateNetBadge();
  setScreen('call');
  haptic('success');

  const session = new CallSession(
    {
      onRemoteVideo: (track: RemoteTrack | null) => {
        if (track) {
          track.attach(remoteVideo);
          remotePlaceholder.hidden = true;
        } else {
          remoteVideo.srcObject = null;
          remotePlaceholder.hidden = false;
        }
      },
      onPartnerGone: () => {
        void endCall();
        showEnded('طرف مقابل تماس را ترک کرد', 'می‌توانید یک تماس جدید شروع کنید.', '👋');
      },
      onDisconnected: () => {
        if (screen !== 'call') return;
        void endCall();
        showEnded('تماس قطع شد', 'ارتباط با سرور تماس از دست رفت.', '📴');
      },
      onNetwork: (state) => {
        rtcReconnecting = state === 'reconnecting';
        updateNetBadge();
      },
      onQuality: (poor) => {
        poorNetwork = poor;
        updateNetBadge();
      },
      onAudioBlocked: () => toast('برای شنیدن صدا، یک‌بار روی صفحه ضربه بزنید.'),
    },
    { forceRelay, quality, codec },
  );
  call = session;

  try {
    await session.connect(url, token, localTracks);
    syncControlIcons();
  } catch (err) {
    console.error('livekit connect failed', err);
    call = null;
    await session.close();
    signal.send({ type: 'leave' });
    releaseMedia();
    showError('خطای اتصال', 'اتصال به سرور تماس برقرار نشد. اینترنت یا فیلترشکن خود را بررسی کنید و دوباره تلاش کنید.');
  }
}

async function endCall(): Promise<void> {
  const session = call;
  call = null;
  wsReconnecting = false;
  rtcReconnecting = false;
  poorNetwork = false;
  updateNetBadge();
  remoteVideo.srcObject = null;
  remotePlaceholder.hidden = false;
  if (session) await session.close();
  releaseMedia();
}

// ── رویدادهای رابط کاربری ───────────────────────────────────────────────────
$('btnStart').addEventListener('click', () => void beginSearch());
$('btnNew').addEventListener('click', () => void beginSearch());
$('btnRetry').addEventListener('click', () => {
  if (!signal.connected) signal.reconnectNow();
  setScreen(authenticated ? 'intro' : 'loading');
});

$('btnCancel').addEventListener('click', () => {
  queued = false;
  signal.send({ type: 'cancel' });
  releaseMedia();
  setScreen('intro');
});

$('btnHangup').addEventListener('click', () => {
  queued = false;
  signal.send({ type: 'leave' });
  void endCall().then(() => showEnded('تماس پایان یافت', 'می‌توانید یک تماس جدید شروع کنید.'));
});

btnMic.addEventListener('click', () => {
  const audio = findAudioTrack(localTracks);
  if (!audio) return;
  void (audio.isMuted ? audio.unmute() : audio.mute()).then(syncControlIcons);
});

btnCam.addEventListener('click', () => {
  const video = findVideoTrack(localTracks);
  if (!video) return;
  void (video.isMuted ? video.unmute() : video.mute()).then(syncControlIcons);
});

// اولین لمس صفحه، قفل پخش خودکار صدا را باز می‌کند
document.addEventListener('click', () => void call?.unblockAudio(), { passive: true });

async function beginSearch(): Promise<void> {
  if (!signal.connected) {
    signal.reconnectNow();
    toast('در حال اتصال به سرور…');
    return;
  }
  if (!authenticated) {
    toast('در حال احراز هویت…');
    return;
  }
  if (!(await ensureMedia())) return;
  queued = true;
  setScreen('waiting');
  signal.send({ type: 'join' });
}

// اگر کاربر به صفحه برگشت و اتصال قطع بود، فوراً دوباره وصل شو
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') signal.reconnectNow();
});

window.addEventListener('pagehide', (event) => {
  // در bfcache صفحه زنده می‌ماند و ممکن است کاربر برگردد؛ فقط هنگام بستن واقعی
  // تماس را تمام می‌کنیم.
  if (!event.persisted) signal.send({ type: 'leave' });
});

// ── شروع ────────────────────────────────────────────────────────────────────
initTelegram();
setScreen('loading');
signal.start();

// اگر تا ۸ ثانیه سرور جواب نداد، پیام خطا نشان بده
setTimeout(() => {
  if (screen === 'loading') {
    showError('اتصال برقرار نشد', 'ارتباط با سرور برقرار نشد. اینترنت خود را بررسی کنید و دوباره تلاش کنید.');
  }
}, 8000);
