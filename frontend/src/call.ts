import {
  LocalAudioTrack,
  LocalTrack,
  LocalVideoTrack,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets43,
  createLocalTracks,
} from 'livekit-client';

export interface CallHandlers {
  onRemoteVideo(track: RemoteTrack | null): void;
  onPartnerGone(): void;
  onDisconnected(reason?: unknown): void;
  onNetwork(state: 'reconnecting' | 'connected'): void;
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

/** گرفتن اجازه و ساخت ترک‌های محلی (۴۸۰p). همین ترک‌ها بعداً منتشر می‌شوند. */
export async function acquireLocalTracks(): Promise<LocalTrack[]> {
  return createLocalTracks({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { resolution: VideoPresets43.h480.resolution, facingMode: 'user' },
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
    forceRelay: boolean,
  ) {
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      videoCaptureDefaults: { resolution: VideoPresets43.h480.resolution, facingMode: 'user' },
      publishDefaults: {
        simulcast: true,
        videoSimulcastLayers: [VideoPresets43.h180, VideoPresets43.h360],
        videoEncoding: VideoPresets43.h480.encoding,
        videoCodec: 'vp8',
        dtx: true,
        red: true,
      },
      // با ?relay=1 فقط از مسیر TURN استفاده می‌شود (برای تست TURN).
      ...(forceRelay ? { rtcConfig: { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } } : {}),
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
