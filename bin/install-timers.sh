#!/usr/bin/env bash
# Install Backbeat systemd user timers (plan 08:00, review 21:30)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
UID_NUM="$(id -u)"
UNIT_DIR="$HOME/.config/systemd/user"

sub() {
  sed -e "s|__BACKBEAT_ROOT__|$HERE|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__UID__|$UID_NUM|g" \
      -e "s|__WAYLAND__|${WAYLAND_DISPLAY:-}|g" \
      -e "s|__DISPLAY__|${DISPLAY:-}|g" "$1"
}

tmp="$(mktemp)"
for f in pi-backbeat-plan.service pi-backbeat-review.service pi-backbeat-plan.timer pi-backbeat-review.timer; do
  sub "$HERE/systemd/$f" > "$tmp"
  install -Dm600 "$tmp" "$UNIT_DIR/$f"
done
rm -f "$tmp"

systemctl --user daemon-reload
systemctl --user enable --now pi-backbeat-plan.timer pi-backbeat-review.timer
echo "Backbeat timers installed: plan 08:00, review 21:30 (systemctl --user list-timers | grep backbeat)"
