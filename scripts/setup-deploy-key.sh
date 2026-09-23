#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  آماده‌سازی استقرار لحظه‌ای با GitHub Actions.
#
#  روی سرور اجرا کنید:   ./scripts/setup-deploy-key.sh
#
#  یک کلید SSH اختصاصیِ فقط برای CI می‌سازد، روی همین سرور نصبش می‌کند،
#  اتصال را تست می‌کند و در پایان دقیقاً می‌گوید کدام مقدار در کدام Secret
#  گیت‌هاب باید گذاشته شود.
#
#  کلید خصوصی فقط روی صفحه‌ی خودتان چاپ می‌شود و جایی فرستاده نمی‌شود.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

KEY="${HOME}/.ssh/anon_video_deploy"
PORT="${SSH_PORT:-22}"

c_ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m→\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()    { printf '\033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen پیدا نشد."
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"

# ── ۱) کلید ─────────────────────────────────────────────────────────────────
if [[ -f "$KEY" ]]; then
  c_info "کلید از قبل وجود دارد: $KEY"
else
  ssh-keygen -t ed25519 -C "github-actions-deploy" -f "$KEY" -N "" -q
  c_ok "کلید اختصاصی CI ساخته شد."
fi
chmod 600 "$KEY"

# ── ۲) نصب کلید عمومی ───────────────────────────────────────────────────────
touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
pub="$(cat "$KEY.pub")"
if grep -qxF "$pub" "$HOME/.ssh/authorized_keys"; then
  c_info "کلید عمومی از قبل در authorized_keys هست."
else
  printf '%s\n' "$pub" >> "$HOME/.ssh/authorized_keys"
  c_ok "کلید عمومی به authorized_keys اضافه شد."
fi

# ── ۳) تست واقعی ────────────────────────────────────────────────────────────
c_info "تست ورود با همین کلید…"
if ssh -i "$KEY" -p "$PORT" -o BatchMode=yes -o StrictHostKeyChecking=no \
     -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 \
     "$(id -un)@127.0.0.1" 'true' 2>/dev/null; then
  c_ok "ورود با کلید کار می‌کند."
else
  c_warn "تست ورود ناموفق بود. اگر sshd روی این سرور ورود با کلید را"
  c_warn "غیرفعال کرده، در /etc/ssh/sshd_config مقدار PubkeyAuthentication"
  c_warn "را yes کنید و systemctl restart ssh بزنید."
fi

# ── ۴) اثر انگشت و آی‌پی ────────────────────────────────────────────────────
ip="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
known="$(ssh-keyscan -p "$PORT" -H "$ip" 2>/dev/null || true)"
[[ -n "$known" ]] || c_warn "ssh-keyscan جواب نداد؛ DEPLOY_KNOWN_HOSTS را خالی بگذارید."

# ── ۵) خروجی ────────────────────────────────────────────────────────────────
line() { printf '%s\n' "────────────────────────────────────────────────────────────"; }
echo
line
printf '  این مقادیر را در Secrets ریپو بگذارید:\n'
printf '  https://github.com/<user>/<repo>/settings/secrets/actions\n'
line
echo
printf '\033[1mDEPLOY_HOST\033[0m\n%s\n\n' "$ip"
printf '\033[1mDEPLOY_USER\033[0m\n%s\n\n' "$(id -un)"
[[ "$PORT" != "22" ]] && printf '\033[1mDEPLOY_PORT\033[0m\n%s\n\n' "$PORT"
printf '\033[1mTELEGRAM_BOT_TOKEN\033[0m\n'
if [[ -f .env ]] && grep -q '^TELEGRAM_BOT_TOKEN=.' .env; then
  printf '(همان توکنی که در .env هست — فقط بار اولِ استقرار لازم است)\n\n'
else
  printf '(توکن ربات خودتان)\n\n'
fi
if [[ -n "$known" ]]; then
  printf '\033[1mDEPLOY_KNOWN_HOSTS\033[0m\n%s\n\n' "$known"
fi
printf '\033[1mDEPLOY_SSH_KEY\033[0m  \033[33m(کل متن زیر، شامل هر دو خط BEGIN و END)\033[0m\n'
line
cat "$KEY"
line
echo
c_warn "بعد از کپی کردن، صفحه‌ی ترمینال را پاک کنید:  clear"
echo
printf '  بعدش یک کامیت پوش کنید — استقرار خودکار و لحظه‌ای انجام می‌شود.\n'
printf '  اگر به‌روزرسانی زمان‌بندی‌شده را نصب کرده‌اید، خاموشش کنید تا دوباره‌کاری نشود:\n'
printf '      ./scripts/install-autoupdate.sh off\n\n'
