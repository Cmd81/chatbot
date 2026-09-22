#!/usr/bin/env node
/**
 * بررسی TURN/STUN:
 *   • UDP 3478 → یک درخواست STUN Binding می‌فرستد و منتظر پاسخ می‌ماند
 *   • TLS 5349 → دست‌دادن TLS و ارسال STUN Binding روی همان کانال
 *
 *   node scripts/check-turn.mjs turn.onlane.top
 */
import dgram from 'node:dgram';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const host = process.argv[2];
if (!host) {
  console.error('استفاده: node scripts/check-turn.mjs <turn-host> [udp-port] [tls-port]');
  process.exit(2);
}
const udpPort = Number(process.argv[3] ?? 3478);
const tlsPort = Number(process.argv[4] ?? 5349);
const TIMEOUT = 6000;

const MAGIC = 0x2112a442;

function bindingRequest() {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0); // Binding Request
  buf.writeUInt16BE(0, 2); // length
  buf.writeUInt32BE(MAGIC, 4);
  randomBytes(12).copy(buf, 8);
  return buf;
}

function parseResponse(req, res) {
  if (res.length < 20) return null;
  const type = res.readUInt16BE(0);
  if (res.readUInt32BE(4) !== MAGIC) return null;
  if (!res.subarray(8, 20).equals(req.subarray(8, 20))) return null;
  // 0x0101 = Binding Success, 0x0111 = Binding Error (هر دو یعنی سرور زنده است)
  if (type !== 0x0101 && type !== 0x0111) return null;

  let offset = 20;
  const end = 20 + res.readUInt16BE(2);
  while (offset + 4 <= end && offset + 4 <= res.length) {
    const attrType = res.readUInt16BE(offset);
    const attrLen = res.readUInt16BE(offset + 2);
    const value = res.subarray(offset + 4, offset + 4 + attrLen);
    if (attrType === 0x0020 && value.length >= 8) {
      // XOR-MAPPED-ADDRESS
      const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
      const ipRaw = value.readUInt32BE(4) ^ MAGIC;
      const ip = [24, 16, 8, 0].map((s) => (ipRaw >>> s) & 0xff).join('.');
      return { type, mapped: `${ip}:${port}` };
    }
    offset += 4 + attrLen + ((4 - (attrLen % 4)) % 4);
  }
  return { type, mapped: null };
}

function checkUdp() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const req = bindingRequest();
    const timer = setTimeout(() => {
      sock.close();
      resolve({ ok: false, detail: 'پاسخی نرسید (UDP بسته است یا سرور خاموش)' });
    }, TIMEOUT);
    sock.on('message', (msg) => {
      const parsed = parseResponse(req, msg);
      clearTimeout(timer);
      sock.close();
      resolve(parsed ? { ok: true, detail: parsed.mapped ? `آدرس دیده‌شده: ${parsed.mapped}` : 'پاسخ STUN معتبر' } : { ok: false, detail: 'پاسخ نامعتبر' });
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      try { sock.close(); } catch { /* noop */ }
      resolve({ ok: false, detail: String(err.message ?? err) });
    });
    sock.send(req, udpPort, host);
  });
}

function checkTls() {
  return new Promise((resolve) => {
    const req = bindingRequest();
    const sock = tls.connect({ host, port: tlsPort, servername: host, ALPNProtocols: [] }, () => {
      if (!sock.authorized) {
        sock.destroy();
        resolve({ ok: false, detail: `گواهی معتبر نیست: ${sock.authorizationError}` });
        return;
      }
      // TURN روی TCP با فریم‌بندی طول‌دار کار می‌کند؛ STUN به‌صورت خام هم پذیرفته می‌شود.
      sock.write(req);
    });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ ok: false, detail: 'دست‌دادن TLS انجام شد ولی پاسخ STUN نرسید' });
    }, TIMEOUT);
    sock.on('data', (msg) => {
      const parsed = parseResponse(req, msg);
      clearTimeout(timer);
      const cert = sock.getPeerCertificate();
      sock.destroy();
      resolve(
        parsed
          ? { ok: true, detail: `TLS معتبر (تا ${cert.valid_to}) — ${parsed.mapped ?? 'پاسخ STUN معتبر'}` }
          : { ok: false, detail: 'پاسخ نامعتبر از TURN/TLS' },
      );
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: String(err.message ?? err) });
    });
  });
}

const [udp, tlsRes] = await Promise.all([checkUdp(), checkTls()]);
const line = (label, r) => console.log(`  ${r.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label} — ${r.detail}`);

console.log(`\nبررسی TURN روی ${host}:`);
line(`UDP ${udpPort}`, udp);
line(`TLS ${tlsPort}`, tlsRes);
console.log();

process.exit(udp.ok && tlsRes.ok ? 0 : 1);
