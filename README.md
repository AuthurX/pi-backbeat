# Backbeat

**The rhythm section for your day.** A local-first AI scheduler for Apple Calendar, powered by [Pi](https://pi.dev). An open-source alternative to Motion / Reclaim.ai — your data never leaves your machine.

It auto-blocks your day at 08:00, reshuffles on conflict via natural chat, and rolls unfinished tasks into tomorrow at 21:30.

## How it works

```
you: "加待办：写周报 周五前 2h 高优先级"
        │
        ▼
~/.assistant/tasks.md   ← todo pool (single source of truth)
        │
   08:00 systemd timer  ──► headless pi -p  ──► reads pool + your calendar
        │                                    (anchors = existing events)
        ▼
Apple Calendar "Backbeat" calendar (iCloud CalDAV, native alarms)
        │
        ▼
iPhone / Mac: native notifications, all day
```

- **Anchors first** — existing events are never touched; tasks fill free slots only
- **Big Rocks First** — top-priority task gets the best morning block
- **Buffers, not gap-filling** — 15 min after meetings, gaps intentionally left
- **Re-plan on conflict** — new meeting? remaining AI blocks reshuffle (`/replan`)
- **Reminders are calendar events** — "remind me in 10 min" = an event with a native alarm
- **Evening rollover** — unfinished tasks stay in the pool, auto-planned tomorrow
- **Learns from you** — fixed blocks ("lunch 12–14") are hard-excluded from free slots; behavioral patterns (you keep moving things to the morning) are distilled at the 21:30 review into `~/.assistant/preferences.md`, shown in the notification, editable at any time. The more you use it, the more it fits you.

## Install

Prerequisites:
- [Pi](https://pi.dev)
- An iCloud **app-specific password**, stored in `~/.assistant/.env` (chmod 600):
  ```
  ICLOUD_USER=you@icloud.com
  ICLOUD_PASSWORD=xxxx xxxx xxxx
  ```
- A Python venv with `caldav` at `~/.assistant/venv`:
  ```bash
  python3 -m venv ~/.assistant/venv
  ~/.assistant/venv/bin/pip install caldav
  ```

```bash
pi install pi-backbeat            # from npm
# or: pi install /path/to/pi-backbeat
```

Daily automation (08:00 plan / 21:30 review, headless pi + desktop notifications):

```bash
bin/install-timers.sh             # installs systemd user timers with your paths
```

## Usage

| You say | What happens |
|---|---|
| 加待办：写周报 周五前 2h 高优先级 | task added to the pool |
| 排一下今天 / `/plan` | day planned into Apple Calendar |
| 客户加了下午2点的会 | meeting added + remaining blocks re-planned |
| `/replan` | re-block the rest of today (deterministic) |
| 提醒我10分钟后喝水 | 10-min event with alarm |
| 周报写完了 | task marked done |
| 把明天健身改到7点 | event moved |
| 复盘 | evening summary + rollover |

## Configuration

Env vars (or `~/.assistant/.env` for credentials only):

| Var | Default |
|---|---|
| `BACKBEAT_HOME` | `~/.assistant` |
| `BACKBEAT_CALENDAR` | `Backbeat` |
| `BACKBEAT_WORKHOURS` | `09:00-12:00,14:00-18:00` |
| `BACKBEAT_TZ` | `Asia/Shanghai` |
| `BACKBEAT_PYTHON` | `~/.assistant/venv/bin/python` |

## vs. the SaaS

| | Motion | Reclaim | **Backbeat** |
|---|---|---|---|
| Price | $19/mo | $10/mo | free |
| Data location | their cloud | their cloud | **your machine** |
| Apple Calendar | sync | sync | **native (CalDAV)** |
| Reminders | in-app | in-app | **native iOS push** |
| Your AI, your rules | ❌ | ❌ | ✅ (Pi) |

## Architecture

```
pi-backbeat/
├── extensions/index.ts   # tasks + prefs + calendar tools, /plan /replan
├── skills/backbeat/      # planning methodology for the LLM
├── bin/ical.py           # CalDAV CLI (all Apple Calendar I/O)
├── bin/plan.sh           # 08:00 headless planner
├── bin/review.sh         # 21:30 headless reviewer
├── bin/install-timers.sh # installs the systemd user timers
└── systemd/              # unit templates
```

## Privacy

Everything stays local: the todo pool, preferences, and behavior feedback live in `~/.assistant/`; calendar I/O is direct CalDAV to your own iCloud account.

## License

MIT — see [LICENSE](./LICENSE)
