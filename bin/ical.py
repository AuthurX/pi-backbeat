#!/usr/bin/env python3
"""Backbeat CalDAV CLI — Apple Calendar (iCloud) operations for the Backbeat pi package.

All commands emit JSON. User data lives in $BACKBEAT_HOME (default ~/.assistant).
"""
import argparse
import datetime as dt
import json
import os
import re
from pathlib import Path
from zoneinfo import ZoneInfo

from caldav import DAVClient, elements
try:
    from icalendar import vDatetime as vCalDateTime  # icalendar 5 & 7
except ImportError:
    from icalendar import vCalDateTime  # icalendar 6

HOME = Path(os.environ.get("BACKBEAT_HOME", str(Path.home() / ".assistant")))
TZ = ZoneInfo(os.environ.get("BACKBEAT_TZ", "Asia/Shanghai"))
AI_CALENDAR = os.environ.get("BACKBEAT_CALENDAR", "Backbeat")
WORK_HOURS = os.environ.get("BACKBEAT_WORKHOURS", "09:00-12:00,14:00-18:00")
MIN_SLOT = 15  # minutes
MARKER = "[backbeat]"


def load_env() -> dict:
    env = {}
    p = HOME / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def client() -> DAVClient:
    e = load_env()
    return DAVClient(
        url=os.environ.get("BACKBEAT_CALDAV_URL", "https://p53-caldav.icloud.com"),
        username=e["ICLOUD_USER"],
        password=e["ICLOUD_PASSWORD"],
    )


def out(data):
    print(json.dumps(data, ensure_ascii=False, default=str))


def cal_name(cal) -> str:
    return cal.get_display_name() or cal.name or ""


def find_cal(c: DAVClient, name: str):
    for cal in c.principal().calendars():
        if cal_name(cal) == name:
            return cal
    return None


def parse_dt(s: str) -> dt.datetime:
    if len(s) <= 5:  # "HH:MM" → today
        h, m = s.split(":")
        now = dt.datetime.now(TZ)
        return now.replace(hour=int(h), minute=int(m), second=0, microsecond=0)
    d = dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=TZ)
    return d


def event_rows(cal, start: dt.datetime, end: dt.datetime) -> list:
    rows = []
    for ev in cal.search(start=start, end=end, event=True):
        comp = ev.icalendar_component
        if comp is None:
            continue
        dts = comp.get("dtstart")
        if dts is None:
            continue
        s = dts.dt
        all_day = isinstance(s, dt.date) and not isinstance(s, dt.datetime)
        if all_day:
            s = dt.datetime.combine(s, dt.time(0, 0), TZ)
        elif s.tzinfo is None:
            s = s.replace(tzinfo=TZ)
        dte = comp.get("dtend")
        e = dte.dt if dte else s + dt.timedelta(minutes=30)
        if isinstance(e, dt.date) and not isinstance(e, dt.datetime):
            e = dt.datetime.combine(e, dt.time(23, 59, 59), TZ)
        elif e.tzinfo is None:
            e = e.replace(tzinfo=TZ)
        rows.append(
            {
                "uid": ev.id,
                "url": str(ev.url),
                "calendar": cal_name(cal),
                "summary": str(comp.get("summary") or ""),
                "description": str(comp.get("description") or ""),
                "start": s.isoformat(),
                "end": e.isoformat(),
                "all_day": all_day,
                "ai": MARKER in str(comp.get("description") or ""),
            }
        )
    return rows


WEEKDAY_MAP = {
    "周一": 0, "周二": 1, "周三": 2, "周四": 3, "周五": 4, "周六": 5, "周日": 6,
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}


def day_matches(spec: str, date: dt.date) -> bool:
    s = spec.lower()
    if s in ("每天", "daily"):
        return True
    if s in ("工作日", "weekdays"):
        return date.weekday() < 5
    if s in ("周末", "weekend"):
        return date.weekday() >= 5
    return date.weekday() == WEEKDAY_MAP.get(s, -1)


def pref_blocks(date: dt.date) -> list:
    """Fixed no-schedule blocks from preferences.md matching this date."""
    p = HOME / "preferences.md"
    if not p.exists():
        return []
    blocks = []
    pat = re.compile(
        r"^- (每天|工作日|周末|周[一二三四五六日]|mon|tue|wed|thu|fri|sat|sun)"
        r"\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s*\S+" , re.IGNORECASE
    )
    for line in p.read_text().splitlines():
        m = pat.match(line.strip())
        if not m or not day_matches(m.group(1), date):
            continue
        sh, sm = map(int, m.group(2).split(":"))
        eh, em = map(int, m.group(3).split(":"))
        blocks.append(
            (
                dt.datetime(date.year, date.month, date.day, sh, sm, tzinfo=TZ),
                dt.datetime(date.year, date.month, date.day, eh, em, tzinfo=TZ),
            )
        )
    return blocks


def work_windows(date: dt.date) -> list:
    wins = []
    for part in WORK_HOURS.split(","):
        a, b = part.split("-")
        ah, am = map(int, a.split(":"))
        bh, bm = map(int, b.split(":"))
        wins.append(
            (
                dt.datetime(date.year, date.month, date.day, ah, am, tzinfo=TZ),
                dt.datetime(date.year, date.month, date.day, bh, bm, tzinfo=TZ),
            )
        )
    return wins


def all_events(c: DAVClient, start: dt.datetime, end: dt.datetime) -> list:
    rows = []
    for cal in c.principal().calendars():
        rows.extend(event_rows(cal, start, end))
    return rows


def find_event(c: DAVClient, uid: str | None, match: str | None, url: str | None):
    if url:
        return c.get_object_by_url(url)
    for cal in c.principal().calendars():
        if uid:
            try:
                return cal.get_object_by_uid(uid)
            except Exception:
                pass
        if match:
            now = dt.datetime.now(TZ)
            for row in event_rows(cal, now - dt.timedelta(days=90), now + dt.timedelta(days=90)):
                if match.lower() in row["summary"].lower():
                    return cal.get_object_by_uid(row["uid"])
    return None


# ---------- commands ----------

def cmd_calendars(c):
    out([{"name": cal_name(cal), "url": str(cal.url)} for cal in c.principal().calendars()])


def cmd_day(c, a):
    date = dt.date.fromisoformat(a.date) if a.date else dt.datetime.now(TZ).date()
    start = dt.datetime.combine(date, dt.time(0, 0), TZ)
    rows = all_events(c, start, start + dt.timedelta(days=1))
    rows.sort(key=lambda r: r["start"])
    out(rows)


def cmd_free(c, a):
    date = dt.date.fromisoformat(a.date) if a.date else dt.datetime.now(TZ).date()
    day_start = dt.datetime.combine(date, dt.time(0, 0), TZ)
    busy = []
    for row in all_events(c, day_start, day_start + dt.timedelta(days=1)):
        if row["all_day"]:
            busy.append((day_start, day_start + dt.timedelta(days=1)))
        else:
            busy.append((dt.datetime.fromisoformat(row["start"]), dt.datetime.fromisoformat(row["end"])))
    busy.extend(pref_blocks(date))
    busy.sort()
    merged = []
    for s, e in busy:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    free = []
    for ws, we in work_windows(date):
        cur = ws
        for s, e in merged:
            if e <= ws or s >= we:
                continue
            if s > cur:
                free.append((cur, min(s, we)))
            cur = max(cur, e)
            if cur >= we:
                break
        if cur < we:
            free.append((cur, we))
    out(
        [
            {"start": s.isoformat(), "end": e.isoformat(), "minutes": int((e - s).total_seconds() // 60)}
            for s, e in free
            if (e - s) >= dt.timedelta(minutes=MIN_SLOT)
        ]
    )


def cmd_add(c, a):
    cal = find_cal(c, a.cal or AI_CALENDAR)
    if cal is None:
        raise SystemExit(f"calendar {a.cal or AI_CALENDAR!r} not found")
    start = parse_dt(a.start)
    end = parse_dt(a.end) if a.end else start + dt.timedelta(minutes=a.minutes or 30)
    kwargs = {}
    if a.rrule:
        rule = {}
        for kv in a.rrule.split(";"):
            k, v = kv.split("=", 1)
            if k == "UNTIL":
                v = v.rstrip("Z")
                if re.fullmatch(r"\d{14}", v):
                    v = f"{v[0:4]}-{v[4:6]}-{v[6:8]}T{v[8:10]}:{v[10:12]}:{v[12:14]}"
                d = dt.datetime.fromisoformat(v)
                rule[k] = d.replace(tzinfo=dt.timezone.utc) if d.tzinfo is None else d
            else:
                rule[k] = v
        kwargs["rrule"] = rule
    ev = cal.add_event(
        summary=a.title,
        dtstart=start,
        dtend=end,
        description=a.desc or "",
        alarm_trigger=dt.timedelta(minutes=a.alarm),
        **kwargs,
    )
    out({"uid": ev.id, "url": str(ev.url), "summary": a.title, "start": start.isoformat(), "end": end.isoformat()})


def cmd_move(c, a):
    ev = find_event(c, a.uid, a.match, a.url)
    if ev is None:
        raise SystemExit("event not found")
    comp = ev.icalendar_component
    start = parse_dt(a.start)
    old_s = comp.get("dtstart").dt
    if isinstance(old_s, dt.date) and not isinstance(old_s, dt.datetime):
        old_s = dt.datetime.combine(old_s, dt.time(0, 0), TZ)
    elif old_s.tzinfo is None:
        old_s = old_s.replace(tzinfo=TZ)
    dte = comp.get("dtend")
    old_e = dte.dt if dte else old_s + dt.timedelta(minutes=30)
    if isinstance(old_e, dt.date) and not isinstance(old_e, dt.datetime):
        old_e = dt.datetime.combine(old_e, dt.time(23, 59, 59), TZ)
    elif old_e.tzinfo is None:
        old_e = old_e.replace(tzinfo=TZ)
    duration = old_e - old_s
    end = parse_dt(a.end) if a.end else start + duration
    comp["dtstart"] = vCalDateTime(start)
    comp["dtend"] = vCalDateTime(end)
    ev.save()
    out({"uid": ev.id, "summary": str(comp.get("summary") or ""), "start": start.isoformat(), "end": end.isoformat()})


def cmd_delete(c, a):
    ev = find_event(c, a.uid, a.match, a.url)
    if ev is None:
        raise SystemExit("event not found")
    summary = str(ev.icalendar_component.get("summary") or "")
    ev.delete()
    out({"deleted": ev.id, "summary": summary})


def cmd_clear_ai(c, a):
    date = dt.date.fromisoformat(a.date) if a.date else dt.datetime.now(TZ).date()
    cal = find_cal(c, a.cal or AI_CALENDAR)
    if cal is None:
        out({"deleted": 0})
        return
    start = dt.datetime.combine(date, dt.time(0, 0), TZ)
    after = dt.datetime.fromisoformat(a.after) if a.after else None
    deleted = 0
    for row in event_rows(cal, start, start + dt.timedelta(days=1)):
        if not row["ai"]:
            continue
        if after and dt.datetime.fromisoformat(row["start"]) <= after:
            continue
        ev = cal.get_object_by_uid(row["uid"])
        ev.delete()
        deleted += 1
    out({"deleted": deleted})


def cmd_rename_cal(c, a):
    cal = find_cal(c, a.from_)
    if cal is None:
        raise SystemExit(f"calendar {a.from_!r} not found")
    cal.set_properties([elements.dav.DisplayName(a.to)])
    out({"renamed": f"{a.from_} -> {a.to}"})


def cmd_move_cal(c, a):
    src = find_cal(c, a.from_)
    dst = find_cal(c, a.to)
    if src is None or dst is None:
        raise SystemExit("calendar not found")
    import uuid

    ev = src.get_object_by_uid(a.uid)
    data = ev.data if isinstance(ev.data, str) else ev.data.decode()
    data = "\n".join(l for l in data.splitlines() if not l.upper().startswith("SCHEDULE-TAG"))
    # iCloud enforces UID uniqueness across calendars: new UID, else PUT → 412
    data = data.replace(f"UID:{a.uid}", f"UID:{uuid.uuid4()}")
    new_ev = dst.add_event(data)
    ev.delete()
    out({"moved": a.uid, "from": a.from_, "to": a.to, "url": str(new_ev.url)})


def cmd_mkcalendar(c, a):
    cal = c.principal().make_calendar(name=a.name)
    out({"name": a.name, "url": str(cal.url)})


def main():
    p = argparse.ArgumentParser(description="Backbeat CalDAV CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("calendars")

    d = sub.add_parser("day")
    d.add_argument("date", nargs="?")

    f = sub.add_parser("free")
    f.add_argument("date", nargs="?")

    a = sub.add_parser("add")
    a.add_argument("--title", required=True)
    a.add_argument("--start", required=True)
    a.add_argument("--end")
    a.add_argument("--minutes", type=int)
    a.add_argument("--cal")
    a.add_argument("--alarm", type=int, default=5)
    a.add_argument("--desc")
    a.add_argument("--rrule", help="e.g. FREQ=WEEKLY;BYDAY=SA;UNTIL=20270101T000000Z")

    m = sub.add_parser("move")
    m.add_argument("--uid")
    m.add_argument("--match")
    m.add_argument("--url")
    m.add_argument("--start", required=True)
    m.add_argument("--end")

    dl = sub.add_parser("delete")
    dl.add_argument("--uid")
    dl.add_argument("--match")
    dl.add_argument("--url")

    ca = sub.add_parser("clear-ai")
    ca.add_argument("date", nargs="?")
    ca.add_argument("--cal")
    ca.add_argument("--after")

    r = sub.add_parser("rename-cal")
    r.add_argument("--from", dest="from_", required=True)
    r.add_argument("--to", required=True)

    mv = sub.add_parser("move-cal")
    mv.add_argument("--uid", required=True)
    mv.add_argument("--from", dest="from_", required=True)
    mv.add_argument("--to", required=True)

    mk = sub.add_parser("mkcalendar")
    mk.add_argument("--name", required=True)

    a_ = p.parse_args()
    c = client()
    {
        "calendars": lambda: cmd_calendars(c),
        "day": lambda: cmd_day(c, a_),
        "free": lambda: cmd_free(c, a_),
        "add": lambda: cmd_add(c, a_),
        "move": lambda: cmd_move(c, a_),
        "delete": lambda: cmd_delete(c, a_),
        "clear-ai": lambda: cmd_clear_ai(c, a_),
        "rename-cal": lambda: cmd_rename_cal(c, a_),
        "move-cal": lambda: cmd_move_cal(c, a_),
        "mkcalendar": lambda: cmd_mkcalendar(c, a_),
    }[a_.cmd]()


if __name__ == "__main__":
    main()
