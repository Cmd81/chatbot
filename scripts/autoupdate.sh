#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  اگر کامیت تازه‌ای روی برنچ فعلی باشد، کد را می‌کشد و سرویس‌ها را به‌روز
#  می‌کند. اگر چیزی عوض نشده باشد، فوراً و بدون build بیرون می‌آید.
#
#  با systemd timer اجرا می‌شود (scripts/install-autoupdate.sh)، ولی دستی هم
#  قابل اجراست:  ./scripts/autoupdate.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

say() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

# اجرای هم‌زمان دو به‌روزرسانی روی یک سرور معنا ندارد
exec 9>"/tmp/anon-video-update.lock"
if ! flock -n 9; then
  say "به‌روزرسانی دیگری در حال اجراست؛ رد شد."
  exit 0
fi

[[ -f .env ]] || { say "فایل .env پیدا نشد؛ اول ./deploy.sh را اجرا کنید."; exit 1; }

branch="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$branch" || { say "git fetch ناموفق بود."; exit 1; }

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$branch")"
if [[ "$local_sha" == "$remote_sha" ]]; then
  exit 0   # چیزی عوض نشده؛ بی‌سر و صدا بیرون
fi

say "کامیت تازه پیدا شد: ${local_sha:0:7} → ${remote_sha:0:7}"

# ── تغییرات محلی ────────────────────────────────────────────────────────────
# deploy.sh ممکن است turn.domain را داخل livekit.yaml هماهنگ کرده باشد و همین
# درخت کار را کثیف کند. فقط همین یک مورد را خودکار حل می‌کنیم؛ هر دست‌کاری
# دیگری روی فایل‌های گیت باید آگاهانه باشد، پس به‌روزرسانی را متوقف می‌کنیم.
# فقط فایل‌های *تحت کنترل گیت* که عوض شده‌اند. فایل‌های untracked (لاگ،
# پشتیبان، هر چیزی که ادمین در پوشه گذاشته) نباید جلوی به‌روزرسانی را بگیرند.
dirty="$(git diff --name-only HEAD -- .)"
if [[ -n "$dirty" ]]; then
  if [[ "$dirty" == "livekit.yaml" ]]; then
    git checkout -- livekit.yaml
  else
    say "فایل‌های تغییر‌یافته‌ی محلی وجود دارد؛ به‌روزرسانی انجام نشد:"
    say "$dirty"
    say "یا تغییرات را commit کنید یا با 'git checkout -- <file>' برگردانید."
    exit 1
  fi
fi

git pull --ff-only --quiet origin "$branch" || { say "git pull ناموفق بود."; exit 1; }

# ساخت و بالا آوردن را به همان اسکریپتی می‌سپاریم که Actions هم استفاده می‌کند،
# تا منطق در دو جا تکرار نشود. قفل را همین‌جا گرفته‌ایم.
say "اجرای استقرار…"
if ANON_LOCK_HELD=1 ./scripts/remote-deploy.sh; then
  say "✔ به‌روزرسانی به ${remote_sha:0:7} انجام شد."
  exit 0
fi

say "✘ استقرار ناموفق بود. لاگ: docker compose logs --tail 80"
exit 1
