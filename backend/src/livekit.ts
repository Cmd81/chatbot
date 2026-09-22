import { randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { config } from './config.js';
import { log } from './logger.js';

const roomService = new RoomServiceClient(
  config.livekit.apiUrl,
  config.livekit.apiKey,
  config.livekit.apiSecret,
);

/** شناسه‌ی ناشناس شرکت‌کننده؛ هیچ ارتباطی با user_id تلگرام ندارد. */
export function anonymousIdentity(): string {
  return `anon_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function newRoomName(): string {
  return randomUUID();
}

export async function createRoom(roomName: string): Promise<void> {
  await roomService.createRoom({
    name: roomName,
    emptyTimeout: config.livekit.roomEmptyTimeout,
    maxParticipants: 2,
  });
}

export async function deleteRoom(roomName: string): Promise<void> {
  try {
    await roomService.deleteRoom(roomName);
  } catch (err) {
    // اگر اتاق از قبل بسته شده باشد خطا طبیعی است.
    log.debug('deleteRoom failed', { roomName, err: String(err) });
  }
}

export async function issueToken(roomName: string, identity: string): Promise<string> {
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity,
    ttl: config.livekit.tokenTtlSeconds,
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    // اجازه‌ی ساخت/مدیریت اتاق به کلاینت داده نمی‌شود.
    roomCreate: false,
    roomAdmin: false,
    roomList: false,
  });
  return at.toJwt();
}

/** سلامت LiveKit: اگر Server API پاسخ بدهد یعنی سرویس بالاست. */
export async function livekitHealthy(): Promise<boolean> {
  try {
    await roomService.listRooms();
    return true;
  } catch (err) {
    log.warn('livekit health check failed', { err: String(err) });
    return false;
  }
}
