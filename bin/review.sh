#!/usr/bin/env bash
# Backbeat evening review — headless pi (run by systemd timer)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PI_BIN="${PI_BIN:-$HOME/.npm-global/bin/pi}"
[ -x "$PI_BIN" ] || PI_BIN="$(command -v pi)"
TODAY="$(date +%F)"

PROMPT="Backbeat 晚间复盘，今天是 $TODAY。
1. 用 tasks 工具列出全部待办（filter all）。
2. 用 calendar 工具 day $TODAY，找出描述带 [backbeat] 的事件。
3. 有 [backbeat] 事件但任务未标 [x] 的 = 未完成（保留在池中即滚入明天，不要删除）。
4. 偏好学习：读 ~/.assistant/feedback.jsonl（今天条目，可能为空）和 ~/.assistant/preferences.md。
   - 用户今天移动/删除了 AI 事件 → 提炼规律（如两次都挪到上午 → '重要任务偏好上午'）
   - 任务在其所在时段完成 → 该时段有效；被滚入 → 记录
   - 把新规律写成简短 bullet 追加到 preferences.md 的『学到的偏好』小节（带日期，合并相似条目，整节最多 15 行）
5. 最后运行: notify-send 'Backbeat 复盘' '完成 X/Y：<完成清单>；未完成滚入明天：<清单>[；新学会：<规律>（说一声就改）]'。
没有新规律就不写『新学会』。不要删除任何日历事件，不要改动任务状态。"

exec "$PI_BIN" -p --no-session "$PROMPT"
