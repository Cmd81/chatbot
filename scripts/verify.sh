#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  بررسی سلامت استقرار. روی خود سرور اجرا کنید:
#      ./scripts/verify.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; fail=$((fail + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[[ -f .env ]] || { echo "فایل .env پیدا نشد."; exit 1; }
set -a; . ./.env; set +a
: "${PUBLIC_HOST:?}" "${TURN_HOST:?}"

head_ "۱) سرویس‌های داکر"
if docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | grep -q .; then
  while read -r svc state; do
    [[ "$state" == "running" ]] && ok "$svc در حال اجراست" || bad "$svc در وضعیت $state است"
  done < <(docker compose ps --format '{{.Service}} {{.State}}')
else
  bad "هیچ سرویسی در حال اجرا نیست"
fi

head_ "۲) سرویس‌های داخلی"
curl -fsS --max-time 5 http://127.0.0.1:3000/livez >/dev/null 2>&1 \
  && ok "بک‌اند روی 127.0.0.1:3000 پاسخ می‌دهد" || bad "بک‌اند پاسخ نمی‌دهد"
health="$(curl -fsS --max-time 8 http://127.0.0.1:3000/healthz 2>/dev/null || true)"
if [[ "$health" == *'"livekit":true'* ]]; then ok "بک‌اند به LiveKit وصل است"; else bad "بک‌اند به LiveKit وصل نیست — $health"; fi
curl -fsS --max-time 5 http://127.0.0.1:7880/ >/dev/null 2>&1 \
  && ok "LiveKit روی 127.0.0.1:7880 پاسخ می‌دهد" || bad "LiveKit پاسخ نمی‌دهد"

head_ "۳) DNS"
server_ip="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
for host in "$PUBLIC_HOST" "$TURN_HOST"; do
  got="$(getent hosts "$host" | awk '{print $1}' | head -1)"
  [[ "$got" == "$server_ip" ]] && ok "$host → $got" || bad "$host → ${got:-یافت نشد} (انتظار: $server_ip)"
done

head_ "۴) HTTPS و گواهی"
for host in "$PUBLIC_HOST" "$TURN_HOST"; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://$host/" 2>/dev/null || echo 000)"
  [[ "$code" =~ ^(200|3..)$ ]] && ok "https://$host پاسخ $code داد" || bad "https://$host پاسخ $code داد"
  expiry="$(echo | openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  [[ -n "$expiry" ]] && ok "گواهی $host معتبر تا $expiry" || bad "گواهی $host خوانده نشد"
done

head_ "۵) WebSocket و مچ‌میکر"
if command -v node >/dev/null 2>&1; then
  WS_URL="wss://$PUBLIC_HOST/ws" node scripts/test-match.mjs >/tmp/anon-video-test.log 2>&1 \
    && ok "تست کامل مچ‌میکر از بیرون با موفقیت انجام شد" \
    || { bad "تست مچ‌میکر ناموفق بود — جزئیات: /tmp/anon-video-test.log"; tail -20 /tmp/anon-video-test.log | sed 's/^/      /'; }
else
  bad "node روی سرور نصب نیست؛ تست مچ‌میکر اجرا نشد (اختیاری)"
fi

head_ "۶) TURN"
if command -v node >/dev/null 2>&1; then
  node scripts/check-turn.mjs "$TURN_HOST" 3478 5349 >/tmp/anon-video-turn.log 2>&1
  turn_rc=$?
  sed -n '2,5p' /tmp/anon-video-turn.log
  [[ $turn_rc -ne 0 ]] && fail=$((fail + 1))
else
  ss -lnup 2>/dev/null | grep -q ':3478' && ok "پورت UDP 3478 باز است" || bad "چیزی روی UDP 3478 گوش نمی‌دهد"
fi

head_ "۷) فایروال"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  for rule in '22' '80' '443' '7881' '7882' '3478' '5349' '50000:60000'; do
    ufw status 2>/dev/null | grep -q "$rule" && ok "قانون $rule موجود است" || bad "قانون $rule موجود نیست"
  done
else
  bad "ufw فعال نیست"
fi

printf '\n%s\n' "────────────────────────────────────────────────"
if [[ $fail -eq 0 ]]; then
  printf '\033[32m✔ همه چیز سالم است.\033[0m\n\n'
else
  printf '\033[31m✘ %d مورد مشکل دارد.\033[0m  لاگ‌ها: docker compose logs -f\n\n' "$fail"
  exit 1
fi
