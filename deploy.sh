#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  نصب و راه‌اندازی «تماس تصویری ناشناس» روی یک سرور اوبونتو/دبیان تازه.
#
#  اجرا (با کاربر root):
#      ./deploy.sh
#
#  اجرای غیرتعاملی:
#      TELEGRAM_BOT_TOKEN=xxx PUBLIC_HOST=chat.example.com \
#      TURN_HOST=turn.example.com ACME_EMAIL=me@example.com ./deploy.sh
#
#  اسکریپت idempotent است؛ اجرای دوباره‌ی آن فقط سرویس‌ها را به‌روز می‌کند.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$(pwd)"
ENV_FILE="$ROOT_DIR/.env"

c_ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m→\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; }
die()    { c_err "$*"; exit 1; }

[[ "$(id -u)" == "0" ]] || die "این اسکریپت باید با کاربر root اجرا شود."

# ── ۱) داکر ─────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  c_info "داکر نصب نیست؛ در حال نصب…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl ufw
  curl -fsSL https://get.docker.com | sh
  c_ok "داکر نصب شد."
else
  c_ok "داکر از قبل نصب است."
fi

docker compose version >/dev/null 2>&1 || die "افزونه‌ی docker compose پیدا نشد. داکر را به‌روز کنید."
systemctl enable --now docker >/dev/null 2>&1 || true

# ── ۲) فایل .env ────────────────────────────────────────────────────────────
rand_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

ask() { # ask <متن> <پیش‌فرض>
  local prompt="$1" default="${2:-}" answer=""
  if [[ -t 0 ]]; then
    read -r -p "$prompt${default:+ [$default]}: " answer || true
  fi
  printf '%s' "${answer:-$default}"
}

if [[ -f "$ENV_FILE" ]]; then
  c_ok "فایل .env موجود است؛ دست نخورد."
else
  c_info "ساخت فایل .env"
  PUBLIC_HOST="${PUBLIC_HOST:-$(ask 'دامنه‌ی اصلی' 'chat.onlane.top')}"
  TURN_HOST="${TURN_HOST:-$(ask 'دامنه‌ی TURN' "turn.${PUBLIC_HOST#*.}")}"
  ACME_EMAIL="${ACME_EMAIL:-$(ask 'ایمیل برای Let'"'"'s Encrypt' "admin@${PUBLIC_HOST#*.}")}"

  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    if [[ -t 0 ]]; then
      read -r -s -p "توکن ربات تلگرام (نمایش داده نمی‌شود): " TELEGRAM_BOT_TOKEN || true
      echo
    fi
  fi
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] || c_warn "توکن ربات خالی ماند؛ بعداً آن را در .env بگذارید (سایت بدون ربات کار می‌کند)."

  umask 077
  cat > "$ENV_FILE" <<EOF
PUBLIC_HOST=$PUBLIC_HOST
TURN_HOST=$TURN_HOST
ACME_EMAIL=$ACME_EMAIL

TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_MODE=${TELEGRAM_MODE:-polling}
TELEGRAM_WEBHOOK_SECRET=$(rand_hex 24)
TELEGRAM_API_ROOT=${TELEGRAM_API_ROOT:-https://api.telegram.org}

LIVEKIT_API_KEY=API$(rand_hex 8)
LIVEKIT_API_SECRET=$(rand_hex 32)

ALLOW_GUEST=${ALLOW_GUEST:-true}
LOG_LEVEL=${LOG_LEVEL:-info}
EOF
  chmod 600 "$ENV_FILE"
  c_ok "فایل .env ساخته شد (دسترسی 600). کلیدهای LiveKit به‌صورت تصادفی تولید شدند."
fi

# شامل کردن مقادیر برای مراحل بعد
set -a; . "$ENV_FILE"; set +a

# دامنه‌ی TURN باید با livekit.yaml یکی باشد
if ! grep -q "domain: *${TURN_HOST}\b" "$ROOT_DIR/livekit.yaml"; then
  c_info "هماهنگ‌سازی turn.domain در livekit.yaml با ${TURN_HOST}"
  sed -i -E "s|^( *domain: *).*|\1${TURN_HOST}|" "$ROOT_DIR/livekit.yaml"
fi

# ── ۳) فایروال ──────────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  c_info "تنظیم فایروال (ufw)"
  ufw allow 22/tcp            >/dev/null   # SSH — همیشه اول
  ufw allow 80/tcp            >/dev/null   # HTTP + چالش ACME
  ufw allow 443/tcp           >/dev/null   # HTTPS
  ufw allow 7881/tcp          >/dev/null   # LiveKit ICE/TCP
  ufw allow 7882/udp          >/dev/null   # LiveKit ICE/UDP (mux)
  ufw allow 3478/udp          >/dev/null   # TURN over UDP
  ufw allow 5349/tcp          >/dev/null   # TURN over TLS
  ufw allow 50000:60000/udp   >/dev/null   # بازه‌ی relay مربوط به TURN
  ufw --force enable          >/dev/null
  c_ok "فایروال فعال شد."
else
  c_warn "ufw نصب نیست؛ از تنظیم فایروال صرف‌نظر شد."
fi

# ── ۴) بررسی DNS ────────────────────────────────────────────────────────────
server_ip="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
for host in "$PUBLIC_HOST" "$TURN_HOST"; do
  resolved="$(getent hosts "$host" | awk '{print $1}' | head -1 || true)"
  if [[ -z "$resolved" ]]; then
    c_warn "DNS برای $host پیدا نشد — تا وقتی رکورد A ساخته نشود، گواهی صادر نمی‌شود."
  elif [[ "$resolved" != "$server_ip" ]]; then
    c_warn "$host به $resolved اشاره می‌کند، نه به $server_ip."
  else
    c_ok "DNS برای $host درست است."
  fi
done

# ── ۵) ساخت و اجرا ──────────────────────────────────────────────────────────
c_info "ساخت ایمیج‌ها (بار اول چند دقیقه طول می‌کشد)…"
docker compose build --pull
c_info "بالا آوردن سرویس‌ها…"
docker compose up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

# ── ۶) بررسی سلامت ──────────────────────────────────────────────────────────
c_info "صبر برای آماده شدن سرویس‌ها…"
ok=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done

echo
if [[ "$ok" == "1" ]]; then
  c_ok "بک‌اند و LiveKit سالم هستند."
else
  c_warn "بک‌اند هنوز سالم گزارش نشده است. لاگ‌ها: docker compose logs -f"
fi

docker compose ps
echo
c_ok "آماده است 🎉"
echo "   وب‌سایت : https://${PUBLIC_HOST}"
echo "   TURN    : turn:${TURN_HOST}:3478  و  turns:${TURN_HOST}:5349"
echo
echo "   بررسی کامل : ./scripts/verify.sh"
echo "   لاگ زنده   : docker compose logs -f"
