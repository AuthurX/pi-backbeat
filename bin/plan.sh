#!/usr/bin/env bash
# Backbeat morning planning — headless pi (run by systemd timer)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PI_BIN="${PI_BIN:-$HOME/.npm-global/bin/pi}"
[ -x "$PI_BIN" ] || PI_BIN="$(command -v pi)"
TODAY="$(date +%F)"

PROMPT="Backbeat 晨间排程，今天是 $TODAY。
1. 用 tasks 工具列出未完成待办。
2. 用 calendar 工具：day $TODAY（锚点）、free $TODAY（空隙，已自动排除偏好固定时段）。
3. 读 ~/.assistant/preferences.md，排程时参考『其他偏好』和『学到的偏好』。
4. 按 backbeat skill 规则排程：calendar clear_ai $TODAY 后把任务块写入 Backbeat 日历（title [Backbeat] <任务>，desc [backbeat] task:<id>，alarm 5）。最重要的任务放早晨。
5. 最后运行: notify-send 'Backbeat 今日日程' '<时间线摘要，最多5行>'。待办池为空则通知 '今日无待办'。
排不下的任务列入摘要的'未排入'。"

exec "$PI_BIN" -p --no-session "$PROMPT"
