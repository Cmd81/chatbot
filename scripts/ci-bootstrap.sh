#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  این اسکریپت از روی runner گیت‌هاب به stdin سرور فرستاده می‌شود (نه از روی
#  چک‌اوت سرور)، پس همیشه نسخه‌ی تازه اجرا می‌شود.
#
#  متغیرهای لازم از سمت workflow تزریق می‌شوند: DIR, REPO_URL, REF, SHA
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

if [ "$(id -u)" = "0" ]; then SUDO=""; else SUDO="sudo -n"; fi

if ! command -v git >/dev/null 2>&1; then
  echo "نصب git…"
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git
fi

if [ ! -d "$DIR/.git" ]; then
  echo "کلون اولیه در $DIR"
  $SUDO mkdir -p "$(dirname "$DIR")"
  $SUDO git clone --quiet --branch "$REF" "$REPO_URL" "$DIR"
  [ "$(id -u)" = "0" ] || $SUDO chown -R "$(id -u):$(id -g)" "$DIR"
fi

cd "$DIR"
git fetch --quiet origin "$REF"

# CI منبع حقیقت است: دقیقاً همان کامیتی که workflow را راه انداخته مستقر
# می‌شود و هر تغییر محلی روی فایل‌های تحت گیت کنار می‌رود. (دامنه‌ی TURN
# بلافاصله بعدش توسط remote-deploy.sh از .env بازسازی می‌شود.)
git reset --hard --quiet "$SHA"
echo "کد روی $(git rev-parse --short HEAD) تنظیم شد."

exec bash scripts/remote-deploy.sh
