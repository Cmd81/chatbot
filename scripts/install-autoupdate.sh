#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  نصب به‌روزرسانی خودکار با systemd timer.
#
#      ./scripts/install-autoupdate.sh            # هر ۵ دقیقه
#      ./scripts/install-autoupdate.sh 15min      # هر ۱۵ دقیقه
#      ./scripts/install-autoupdate.sh off        # حذف
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"
INTERVAL="${1:-5min}"
UNIT=anon-video-update

[[ "$(id -u)" == "0" ]] || { echo "این اسکریپت باید با کاربر root اجرا شود."; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "systemd پیدا نشد."; exit 1; }

if [[ "$INTERVAL" == "off" ]]; then
  systemctl disable --now "$UNIT.timer" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$UNIT.timer" "/etc/systemd/system/$UNIT.service"
  systemctl daemon-reload
  echo "✔ به‌روزرسانی خودکار حذف شد."
  exit 0
fi

cat > "/etc/systemd/system/$UNIT.service" <<UNITEOF
[Unit]
Description=به‌روزرسانی خودکار تماس تصویری ناشناس
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
ExecStart=$ROOT_DIR/scripts/autoupdate.sh
TimeoutStartSec=1800
UNITEOF

cat > "/etc/systemd/system/$UNIT.timer" <<UNITEOF
[Unit]
Description=بررسی دوره‌ای کامیت‌های تازه

[Timer]
OnBootSec=3min
OnUnitActiveSec=$INTERVAL
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
UNITEOF

chmod +x "$ROOT_DIR/scripts/autoupdate.sh"
systemctl daemon-reload
systemctl enable --now "$UNIT.timer"

echo "✔ به‌روزرسانی خودکار فعال شد (هر $INTERVAL)."
echo
echo "   وضعیت    : systemctl status $UNIT.timer"
echo "   زمان بعدی : systemctl list-timers $UNIT.timer"
echo "   لاگ       : journalctl -u $UNIT.service -f"
echo "   اجرای فوری: systemctl start $UNIT.service"
echo "   خاموش     : ./scripts/install-autoupdate.sh off"
