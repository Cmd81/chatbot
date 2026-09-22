import { config } from './config.js';
import { log } from './logger.js';
import { anonymousIdentity, createRoom, deleteRoom, issueToken, newRoomName } from './livekit.js';
import type { Peer } from './protocol.js';

/**
 * مچ‌میکر درون‌حافظه‌ای با یک «جایگاه انتظار».
 *
 * قاعده‌ی جلوگیری از race: تمام تغییر وضعیت صف و جفت‌سازی در یک تابع
 * *کاملاً همگام* (بدون await) انجام می‌شود. چون Node تک‌نخی است، این بخش
 * اتمیک است و امکان ندارد دو نفر هم‌زمان یک نفرِ منتظر را بردارند.
 * کارهای async (ساخت اتاق و صدور توکن) بعد از بستن آن بخش انجام می‌شوند.
 */
export class Matchmaker {
  private waiting: Peer | null = null;
  private readonly rooms = new Map<string, [Peer, Peer]>();
  private matchCounter = 0;

  stats(): { waiting: number; rooms: number; matches: number } {
    return { waiting: this.waiting ? 1 : 0, rooms: this.rooms.size, matches: this.matchCounter };
  }

  join(peer: Peer): void {
    if (!peer.identity) {
      peer.send({ type: 'error', code: 'not_authenticated', message: 'ابتدا باید احراز هویت شوید.' });
      return;
    }
    if (peer.state === 'waiting') {
      peer.send({ type: 'waiting' }); // idempotent
      return;
    }
    if (peer.state === 'matching' || peer.state === 'matched') {
      peer.send({ type: 'error', code: 'already_in_call', message: 'شما هم‌اکنون در یک تماس هستید.' });
      return;
    }

    // ─────────── شروع بخش اتمیک (بدون await) ───────────
    const current = this.waiting;
    if (current && current !== peer && current.identity === peer.identity) {
      // همان کاربر از تب/دستگاه دیگر وارد شده؛ اتصال قدیمی از صف خارج می‌شود
      // تا کاربر با خودش مچ نشود و دو بار هم در صف نماند.
      this.waiting = null;
      current.state = 'idle';
      if (current.isOpen()) current.send({ type: 'cancelled', reason: 'replaced' });
    }

    if (this.waiting === null) {
      this.waiting = peer;
      peer.state = 'waiting';
      peer.send({ type: 'waiting' });
      log.info('peer waiting', { connId: peer.connId });
      return;
    }

    const partner = this.waiting;
    this.waiting = null;
    const roomName = newRoomName();
    peer.state = 'matching';
    partner.state = 'matching';
    peer.roomName = roomName;
    partner.roomName = roomName;
    peer.partner = partner;
    partner.partner = peer;
    this.rooms.set(roomName, [partner, peer]);
    this.matchCounter += 1;
    // ─────────── پایان بخش اتمیک ───────────

    log.info('match created', { roomName, a: partner.connId, b: peer.connId });
    void this.finalizeMatch(roomName, partner, peer);
  }

  private async finalizeMatch(roomName: string, a: Peer, b: Peer): Promise<void> {
    try {
      try {
        await createRoom(roomName);
      } catch (err) {
        // اتاق در صورت نبود، هنگام اتصال اولین شرکت‌کننده ساخته می‌شود.
        log.warn('createRoom failed, relying on auto-create', { roomName, err: String(err) });
      }

      const [tokenA, tokenB] = await Promise.all([
        issueToken(roomName, anonymousIdentity()),
        issueToken(roomName, anonymousIdentity()),
      ]);

      // ممکن است در فاصله‌ی صدور توکن یکی از طرفین قطع شده باشد.
      if (a.roomName !== roomName || b.roomName !== roomName || !a.isOpen() || !b.isOpen()) {
        throw new Error('peer_gone');
      }

      a.state = 'matched';
      b.state = 'matched';
      a.send({ type: 'matched', room: roomName, url: config.livekit.url, token: tokenA });
      b.send({ type: 'matched', room: roomName, url: config.livekit.url, token: tokenB });
    } catch (err) {
      log.error('finalize match failed', { roomName, err: String(err) });
      this.rooms.delete(roomName);
      for (const p of [a, b]) {
        if (p.roomName !== roomName) continue; // قبلاً پاک‌سازی شده
        p.state = 'idle';
        p.roomName = null;
        p.partner = null;
        if (p.isOpen()) {
          p.send({ type: 'error', code: 'match_failed', message: 'برقراری تماس ممکن نشد. دوباره تلاش کنید.' });
        }
      }
      void deleteRoom(roomName);
    }
  }

  /** لغو انتظار توسط خود کاربر. اگر در تماس باشد، معادل leave است. */
  cancel(peer: Peer): void {
    if (peer.state === 'waiting') {
      if (this.waiting === peer) this.waiting = null;
      peer.state = 'idle';
      peer.send({ type: 'cancelled', reason: 'user' });
      return;
    }
    if (peer.state === 'matching' || peer.state === 'matched') {
      this.leave(peer);
      return;
    }
    peer.send({ type: 'cancelled', reason: 'user' });
  }

  /** پایان تماس توسط خود کاربر. */
  leave(peer: Peer): void {
    const wasInCall = peer.state === 'matching' || peer.state === 'matched';
    this.teardown(peer, true);
    if (peer.isOpen()) peer.send({ type: wasInCall ? 'call_ended' : 'cancelled' });
  }

  /** قطع شدن اتصال (بسته شدن سوکت). */
  disconnect(peer: Peer): void {
    this.teardown(peer, true);
  }

  /**
   * پاک‌سازی idempotent: کاربر را از صف و اتاق خارج می‌کند و در صورت نیاز
   * به طرف مقابل خبر می‌دهد و اتاق را در LiveKit می‌بندد.
   */
  private teardown(peer: Peer, notifyPartner: boolean): void {
    if (this.waiting === peer) this.waiting = null;

    const roomName = peer.roomName;
    const partner = peer.partner;

    peer.state = 'idle';
    peer.roomName = null;
    peer.partner = null;

    if (partner) {
      partner.partner = null;
      partner.roomName = null;
      partner.state = 'idle';
      if (this.waiting === partner) this.waiting = null;
      if (notifyPartner && partner.isOpen()) partner.send({ type: 'partner_left' });
    }

    if (roomName) {
      this.rooms.delete(roomName);
      void deleteRoom(roomName);
      log.info('room closed', { roomName });
    }
  }
}
