import {
  ConnectionQuality,
  LocalAudioTrack,
  LocalTrack,
  LocalVideoTrack,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
  videoCodecs,
} from 'livekit-client';
import type { ScalabilityMode, VideoCodec, VideoPreset } from 'livekit-client';

/**
 * VP8 پیش‌فرض است چون روی همه‌ی مرورگرها (از جمله WebView تلگرام روی iOS)
 * کار می‌کند. VP9/AV1 در همان پهنای باند کیفیت بهتری می‌دهند ولی پشتیبانی‌شان
 * روی Safari/iOS قابل اتکا نیست — با ?codec=vp9 قابل آزمایش است.
 */
export function resolveCodec(value: string | null): VideoCodec {
  return (videoCodecs as readonly string[]).includes(value ?? '') ? (value as VideoCodec) : 'vp8';
}

export interface CallOptions {
  forceRelay: boolean;
  /** پله‌ی شروع؛ در حالت خودکار بعداً توسط AdaptiveQuality تغییر می‌کند. */
  preset: VideoPreset;
  codec: VideoCodec;
}

export interface CallHandlers {
  onRemoteVideo(track: RemoteTrack | null): void;
  onPartnerGone(): void;
  onDisconnected(reason?: unknown): void;
  onNetwork(state: 'reconnecting' | 'connected'): void;
  onQuality(poor: boolean): void;
  onAudioBlocked(): void;
}

/** پیام فارسی برای خطاهای رایج دوربین/میکروفون. */
export function mediaErrorMessage(err: unknown): string {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return 'مرورگر شما اجازه‌ی دسترسی به دوربین را نمی‌دهد. مطمئن شوید صفحه با HTTPS باز شده است.';
  }
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'اجازه‌ی دسترسی به دوربین یا میکروفون داده نشد. از تنظیمات مرورگر (یا تلگرام) دسترسی را فعال کنید و دوباره تلاش کنید.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'دوربین یا میکروفونی پیدا نشد. دستگاه را بررسی کنید.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'دوربین یا میکروفون در حال استفاده توسط برنامه‌ی دیگری است. آن برنامه را ببندید و دوباره تلاش کنید.';
    case 'AbortError':
      return 'دسترسی به دوربین نیمه‌کاره ماند. دوباره تلاش کنید.';
    default:
      return 'دسترسی به دوربین و میکروفون ممکن نشد. دوباره تلاش کنید.';
  }
}

/** گرفتن اجازه و ساخت ترک‌های محلی. همین ترک‌ها بعداً منتشر می‌شوند. */
export async function acquireLocalTracks(preset: VideoPreset): Promise<LocalTrack[]> {
  return createLocalTracks({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: {
      resolution: preset.resolution,
      frameRate: preset.encoding.maxFramerate,
      facingMode: 'user',
    },
  });
}

export function findVideoTrack(tracks: LocalTrack[]): LocalVideoTrack | null {
  return (tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined) ?? null;
}

export function findAudioTrack(tracks: LocalTrack[]): LocalAudioTrack | null {
  return (tracks.find((t) => t.kind === Track.Kind.Audio) as LocalAudioTrack | undefined) ?? null;
}

export function stopTracks(tracks: LocalTrack[]): void {
  for (const t of tracks) {
    try {
      t.stop();
    } catch {
      /* noop */
    }
  }
}

/**
 * یک جلسه‌ی تماس روی LiveKit.
 *
 * LiveKit یک SFU است: هیچ اتصال P2P بین دو کاربر برقرار نمی‌شود و ICE
 * candidateهای طرفین با هم مبادله نمی‌شوند، بنابراین آی‌پی کاربران به هم
 * نشت نمی‌کند. کل ویدیو و صدا از سرور عبور می‌کند.
 */
export class CallSession {
  readonly room: Room;
  private readonly audioEls = new Map<string, HTMLAudioElement>();
  private closed = false;

  constructor(
    private readonly handlers: CallHandlers,
    options: CallOptions,
  ) {
    const preset = options.preset;
    const svc = options.codec === 'vp9' || options.codec === 'av1';

    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      videoCaptureDefaults: { resolution: preset.resolution, facingMode: 'user' },
      publishDefaults: {
        // در تماس دو‌نفره فقط یک مشترک وجود دارد. simulcast بودجه‌ی انکودر و
        // پهنای باند آپلود را بین سه لایه تقسیم می‌کند، پس لایه‌ی بالا سهم
        // کمتری می‌گیرد و کیفیت پایین می‌آید. با خاموش کردنش کل بودجه صرف
        // یک جریان می‌شود. تطبیق با شبکه‌ی ضعیف همچنان توسط congestion
        // control خود WebRTC انجام می‌شود.
        simulcast: false,
        videoEncoding: preset.encoding,
        videoCodec: options.codec,
        degradationPreference: 'balanced',
        dtx: true,
        red: true,
        // کدک‌های SVC لایه‌های زمانی دارند و بدون simulcast هم تطبیق‌پذیرند.
        ...(svc ? { scalabilityMode: 'L1T3' as ScalabilityMode } : {}),
      },
      // با ?relay=1 فقط از مسیر TURN استفاده می‌شود (برای تست TURN).
      ...(options.forceRelay ? { rtcConfig: { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } } : {}),
    });

    this.room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Video) {
          this.handlers.onRemoteVideo(track);
        } else if (track.kind === Track.Kind.Audio) {
          const el = track.attach() as HTMLAudioElement;
          el.autoplay = true;
          el.style.display = 'none';
          document.body.appendChild(el);
          this.audioEls.set(track.sid ?? String(this.audioEls.size), el);
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        try {
          track.detach().forEach((el) => el.remove());
        } catch {
          /* noop */
        }
        if (track.kind === Track.Kind.Video) this.handlers.onRemoteVideo(null);
      })
      .on(RoomEvent.ParticipantDisconnected, (_p: RemoteParticipant) => {
        if (!this.closed) this.handlers.onPartnerGone();
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (!this.closed) this.handlers.onDisconnected(reason);
      })
      .on(RoomEvent.Reconnecting, () => this.handlers.onNetwork('reconnecting'))
      .on(RoomEvent.Reconnected, () => this.handlers.onNetwork('connected'))
      // اگر کیفیت بد باشد، کاربر باید بداند مقصر شبکه است نه برنامه
      .on(RoomEvent.ConnectionQualityChanged, () => {
        const qualities = [
          this.room.localParticipant.connectionQuality,
          ...[...this.room.remoteParticipants.values()].map((p) => p.connectionQuality),
        ];
        const poor = qualities.some((q) => q === ConnectionQuality.Poor || q === ConnectionQuality.Lost);
        this.handlers.onQuality(poor);
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (!this.room.canPlaybackAudio) this.handlers.onAudioBlocked();
      });
  }

  async connect(url: string, token: string, localTracks: LocalTrack[]): Promise<void> {
    await this.room.connect(url, token, { autoSubscribe: true });
    for (const track of localTracks) {
      await this.room.localParticipant.publishTrack(track);
    }
  }

  /** مرورگرها گاهی پخش صدا را تا اولین لمس کاربر بلاک می‌کنند. */
  async unblockAudio(): Promise<void> {
    try {
      await this.room.startAudio();
    } catch {
      /* noop */
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const el of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    try {
      await this.room.disconnect(true);
    } catch {
      /* noop */
    }
  }
}
