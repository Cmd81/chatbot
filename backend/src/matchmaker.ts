import { config } from './config.js';
import { log } from './logger.js';
import { anonymousIdentity, createRoom, deleteRoom, issueToken, newRoomName } from './livekit.js';
import type { Peer } from './protocol.js';

/**
 * مچ‌میکر درون‌حافظه‌ای با یک صف FIFO.
 *
 * هر کس وارد می‌شود، اگر کسی در صف باشد فوراً به **قدیمی‌ترین نفرِ صف** وصل
 * می‌شود؛ وگرنه خودش ته صف می‌ایستد.
 *
 * قاعده‌ی جلوگیری از race: تمام تغییر صف و جفت‌سازی در یک تابع *کاملاً همگام*
 * (بدون await) انجام می‌شود. چون Node تک‌نخی است، این بخش اتمیک است و امکان
 * ندارد دو نفر هم‌زمان یک نفرِ منتظر را بردارند. کارهای async (ساخت اتاق و
 * صدور توکن) بعد از بستن آن بخش انجام می‌شوند.
 */
export class Matchmaker {
  private readonly queue: Peer[] = [];
  private readonly rooms = new Map<string, [Peer, Peer]>();
  private matchCounter = 0;

  stats(): { waiting: number; rooms: number; matches: number } {
    return { waiting: this.queue.length, rooms: this.rooms.size, matches: this.matchCounter };
  }

  join(peer: Peer): void {
    if (!peer.identity) {
      peer.send({ type: 'error', code: 'not_authenticated', message: 'ابتدا باید احراز هویت شوید.' });
      return;
    }
    if (peer.state === 'waiting') {
      this.sendPosition(peer, true); // idempotent
      return;
    }
    if (peer.state === 'matching' || peer.state === 'matched') {
      peer.send({ type: 'error', code: 'already_in_call', message: 'شما هم‌اکنون در یک تماس هستید.' });
      return;
    }

    // ─────────── شروع بخش اتمیک (بدون await) ───────────
    this.pruneClosed();

    // هر کاربر فقط یک جایگاه در صف دارد؛ اتصال قدیمی‌تر کنار می‌رود تا یک
    // نفر نتواند چند جای صف را اشغال کند و با خودش هم مچ نشود.
    this.evictSameIdentity(peer);

    // قدیمی‌ترین نفرِ صف که همان کاربر نباشد
    const index = this.queue.findIndex((p) => p.identity !== peer.identity);

    if (index === -1) {
      this.queue.push(peer);
      peer.state = 'waiting';
      log.info('peer queued', { connId: peer.connId, queue: this.queue.length });
      this.broadcastPositions();
      return;
    }

    const partner = this.queue.splice(index, 1)[0] as Peer;
    const roomName = newRoomName();
    peer.state = 'matching';
    partner.state = 'matching';
    peer.roomName = roomName;
    partner.roomName = roomName;
    peer.partner = partner;
    partner.partner = peer;
    partner.lastPosition = null;
    this.rooms.set(roomName, [partner, peer]);
    this.matchCounter += 1;
    // ─────────── پایان بخش اتمیک ───────────

    log.info('match created', { roomName, a: partner.connId, b: peer.connId, queue: this.queue.length });
    this.broadcastPositions();
    void this.finalizeMatch(roomName, partner, peer);
  }

  /** پایان تماس فعلی و برگشت فوری به صف. */
  next(peer: Peer): void {
    this.teardown(peer, true);
    this.join(peer);
  }

  /** لغو انتظار توسط خود کاربر. اگر در تماس باشد، معادل leave است. */
  cancel(peer: Peer): void {
    if (peer.state === 'waiting') {
      this.removeFromQueue(peer);
      peer.state = 'idle';
      peer.send({ type: 'cancelled', reason: 'user' });
      this.broadcastPositions();
      return;
    }
    if (peer.state === 'matching' || peer.state === 'matched') {
      this.leave(peer);
      return;
    }
    peer.send({ type: 'cancelled', reason: 'user' });
  }

  /** پایان تماس توسط خود کاربر (بدون برگشت به صف). */
  leave(peer: Peer): void {
    const wasInCall = peer.state === 'matching' || peer.state === 'matched';
    this.teardown(peer, true);
    if (peer.isOpen()) peer.send({ type: wasInCall ? 'call_ended' : 'cancelled' });
  }

  /** قطع شدن اتصال (بسته شدن سوکت). */
  disconnect(peer: Peer): void {
    this.teardown(peer, true);
  }

  // ───────────────────────────── داخلی ─────────────────────────────

  private removeFromQueue(peer: Peer): boolean {
    const i = this.queue.indexOf(peer);
    if (i === -1) return false;
    this.queue.splice(i, 1);
    peer.lastPosition = null;
    return true;
  }

  private pruneClosed(): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const p = this.queue[i] as Peer;
      if (!p.isOpen()) {
        this.queue.splice(i, 1);
        p.state = 'idle';
        p.lastPosition = null;
      }
    }
  }

  private evictSameIdentity(peer: Peer): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const p = this.queue[i] as Peer;
      if (p === peer || p.identity !== peer.identity) continue;
      this.queue.splice(i, 1);
      p.state = 'idle';
      p.lastPosition = null;
      if (p.isOpen()) p.send({ type: 'cancelled', reason: 'replaced' });
    }
  }

  private sendPosition(peer: Peer, force = false): void {
    const i = this.queue.indexOf(peer);
    if (i === -1) return;
    const position = i + 1;
    if (!force && peer.lastPosition === position) return;
    peer.lastPosition = position;
    peer.send({ type: 'waiting', position, total: this.queue.length });
  }

  /** بعد از هر تغییر صف، جایگاه تازه به کسانی که عوض شده اعلام می‌شود. */
  private broadcastPositions(): void {
    for (const p of this.queue) this.sendPosition(p);
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

  /**
   * پاک‌سازی idempotent: کاربر را از صف و اتاق خارج می‌کند و در صورت نیاز
   * به طرف مقابل خبر می‌دهد و اتاق را در LiveKit می‌بندد.
   */
  private teardown(peer: Peer, notifyPartner: boolean): void {
    const wasQueued = this.removeFromQueue(peer);

    const roomName = peer.roomName;
    const partner = peer.partner;

    peer.state = 'idle';
    peer.roomName = null;
    peer.partner = null;

    if (partner) {
      this.removeFromQueue(partner);
      partner.partner = null;
      partner.roomName = null;
      partner.state = 'idle';
      if (notifyPartner && partner.isOpen()) partner.send({ type: 'partner_left' });
    }

    if (roomName) {
      this.rooms.delete(roomName);
      void deleteRoom(roomName);
      log.info('room closed', { roomName });
    }

    if (wasQueued || partner) this.broadcastPositions();
  }
}
