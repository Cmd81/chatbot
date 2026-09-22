#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  اسکریپتی که GitHub Actions روی سرور اجرا می‌کند.
#  به‌صورت دستی هم قابل اجراست:  bash scripts/remote-deploy.sh
#
#  متغیرهای ورودی (همه اختیاری):
#    FORCE_FULL=true   اجبار به اجرای کامل deploy.sh
#    TELEGRAM_BOT_TOKEN / PUBLIC_HOST / TURN_HOST / ACME_EMAIL
#        فقط بار اول (وقتی .env هنوز ساخته نشده) استفاده می‌شوند.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(id -u)" == "0" ]]; then SUDO=""; else SUDO="sudo -n"; fi

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; }

# ── تصمیم: استقرار کامل یا فقط به‌روزرسانی؟ ─────────────────────────────────
full=0
[[ "${FORCE_FULL:-false}" == "true" ]] && full=1
command -v docker >/dev/null 2>&1 || full=1
[[ -f .env ]] || full=1

if [[ $full == 1 ]]; then
  step "استقرار کامل (نصب داکر، ساخت .env، تنظیم فایروال)"
  chmod +x ./deploy.sh
  # وقتی SUDO خالی است نباید «-E» به‌تنهایی اجرا شود
  if [[ -n "$SUDO" ]]; then
    exec $SUDO -E ./deploy.sh
  else
    exec ./deploy.sh
  fi
fi

# ── مسیر سریع: فقط ساخت دوباره و بالا آوردن ────────────────────────────────
step "ساخت ایمیج‌ها"
$SUDO docker compose build

step "بالا آوردن سرویس‌ها"
$SUDO docker compose up -d --remove-orphans
$SUDO docker image prune -f >/dev/null 2>&1 || true

step "بررسی سلامت"
for _ in $(seq 1 40); do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    ok "بک‌اند و LiveKit سالم هستند."
    $SUDO docker compose ps
    exit 0
  fi
  sleep 3
done

err "سرویس ظرف ۲ دقیقه سالم نشد."
$SUDO docker compose ps
$SUDO docker compose logs --tail 60
exit 1
