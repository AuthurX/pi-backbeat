import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);

const HERE = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return __dirname;
  }
})();
const PKG = join(HERE, "..");
const HOME_DIR = process.env.BACKBEAT_HOME ?? join(process.env.HOME ?? "/root", ".assistant");
const VENV_PY = process.env.BACKBEAT_PYTHON || join(HOME_DIR, "venv", "bin", "python");
const TASKS_FILE = process.env.BACKBEAT_TASKS || join(HOME_DIR, "tasks.md");
const PREFS_FILE = process.env.BACKBEAT_PREFS || join(HOME_DIR, "preferences.md");
const FEEDBACK_FILE = join(HOME_DIR, "feedback.jsonl");

function logFeedback(entry: Record<string, unknown>): void {
  try {
    appendFileSync(FEEDBACK_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // non-fatal
  }
}
const ICS = join(PKG, "bin", "ical.py");
const MARKER = "[backbeat]";

async function ical(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await pexec(VENV_PY, [ICS, ...args], { maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim() || stderr.trim();
  } catch (e: any) {
    throw new Error(e.stderr?.trim() || e.message);
  }
}

// ---------- tasks ----------

type Task = { id: string; text: string; meta: string; done: boolean };

function parseTasks(): Task[] {
  if (!existsSync(TASKS_FILE)) return [];
  const tasks: Task[] = [];
  for (const line of readFileSync(TASKS_FILE, "utf8").split("\n")) {
    const m = line.match(/^- \[( |x|X)\] (T\d+)\s+(.+)$/);
    if (!m) continue;
    const parts = m[3].split(/\s*\|\s*/);
    tasks.push({ id: m[2], text: parts[0], meta: parts.slice(1).join(" | "), done: m[1] !== " " });
  }
  return tasks;
}

function fmtTask(t: Task): string {
  return `- [${t.done ? "x" : " "}] ${t.id} ${t.text}${t.meta ? " | " + t.meta : ""}`;
}

function writeTasks(tasks: Task[]): void {
  let header = "# Backbeat 待办池";
  if (existsSync(TASKS_FILE)) {
    const kept = readFileSync(TASKS_FILE, "utf8")
      .split("\n")
      .filter((l) => !l.match(/^- \[[ xX]\] T\d+/))
      .join("\n")
      .trimEnd();
    if (kept) header = kept;
  }
  writeFileSync(TASKS_FILE, `${header}\n\n${tasks.map(fmtTask).join("\n")}\n`);
}

function nextId(tasks: Task[]): string {
  const max = tasks.reduce((mx, t) => Math.max(mx, parseInt(t.id.slice(1), 10) || 0), 0);
  return "T" + String(max + 1).padStart(2, "0");
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const err = (text: string) => ({ content: [{ type: "text" as const, text: `ERROR: ${text}` }], details: {} });

// ---------- deterministic planning ----------

function durMin(meta: string): number {
  const m = meta.match(/(\d+(?:\.\d+)?)\s*(h|min|m|小时|分钟|分|时)/);
  if (!m) return 60;
  const v = parseFloat(m[1]);
  const short = m[2] === "m" || m[2] === "min" || m[2] === "分钟" || m[2] === "分";
  return Math.max(15, Math.round(short ? v : v * 60));
}

function prio(meta: string): number {
  const m = meta.match(/P([0-3])/);
  return m ? parseInt(m[1], 10) : 2;
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const TZ = process.env.BACKBEAT_TZ ?? "Asia/Shanghai";
const NEAR_DAYS = 14; // dates within ±14d of today pass without a user mention

function tzDateStr(tz = TZ): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return todayStr();
  }
}

function dayDiff(dateStr: string, todayStr: string): number {
  return Math.round((Date.parse(dateStr + "T00:00:00Z") - Date.parse(todayStr + "T00:00:00Z")) / 86400000);
}

function dateEcho(date: string | undefined, json: string): string {
  const d = date ?? tzDateStr();
  const today = tzDateStr();
  return `date: ${d}${d !== today ? ` (today: ${today})` : ""}\n${json}`;
}

function recentUserText(ctx: ExtensionContext, maxUser = 12): string {
  try {
    const entries = ctx.sessionManager.getBranch() as any[];
    const texts: string[] = [];
    for (const e of entries) {
      if (e?.type !== "message" || e.message?.role !== "user") continue;
      const c = e.message.content;
      if (typeof c === "string") texts.push(c);
      else if (Array.isArray(c)) texts.push(c.map((b: any) => (b?.type === "text" ? b.text : "")).join(" "));
    }
    return texts.slice(-maxUser).join("\n");
  } catch {
    return "";
  }
}

/** Returns a block reason when date is implausible (far from today, never mentioned by user). */
function dateGuard(date: string | undefined, userText: string): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const today = tzDateStr();
  if (date === today) return null;
  const diff = Math.abs(dayDiff(date, today));
  if (diff <= NEAR_DAYS) return null;
  if (userText.includes(date)) return null;
  return `日期防护：${date} 与今天 ${today} 相差 ${diff} 天，且用户近期消息未提及该日期。查今天请省略 date 参数重试；如用户确指该日期（可能用非 ISO 写法），请先向用户确认。`;
}

function dueRank(meta: string, today: string): number {
  if (meta.includes("今天")) return 0;
  if (meta.includes("明天")) return 1;
  const d = meta.match(/due:(\d{1,2})-(\d{1,2})/);
  if (d) {
    const [y, m2, dd] = today.split("-").map(Number);
    const dueDate = new Date(y, m2 - 1, dd);
    const target = new Date(y, parseInt(d[1], 10) - 1, parseInt(d[2], 10));
    const diff = Math.round((target.getTime() - dueDate.getTime()) / 86400000);
    if (diff <= 0) return 0;
    return Math.min(4, 1 + diff);
  }
  if (meta.includes("本周")) return 4;
  return 5;
}

function fmtDT(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function runPlan(ctx: ExtensionCommandContext, replan: boolean): Promise<void> {
  const date = todayStr();
  const now = new Date();
  const tasks = parseTasks().filter((t) => !t.done);

  // events already on the calendar (anchors + existing AI events)
  const dayJson: any[] = JSON.parse(await ical(["day", date]));
  const aiEvents = dayJson.filter((e) => e.ai);
  const running = new Set(
    aiEvents
      .filter((e) => new Date(e.start) <= now && new Date(e.end) > now)
      .map((e) => (e.description.match(/task:(T\d+)/) || [])[1])
  );

  if (replan) {
    await ical(["clear-ai", date, "--after", fmtDT(now)]);
  } else {
    await ical(["clear-ai", date]);
  }

  const freeJson: any[] = JSON.parse(await ical(["free", date]));
  const slots = freeJson.filter((s) => new Date(s.start) > now).map((s) => ({ start: s.start, left: s.minutes }));

  const queue = tasks
    .filter((t) => !running.has(t.id))
    .sort((a, b) => prio(a.meta) - prio(b.meta) || dueRank(a.meta, date) - dueRank(b.meta, date));

  const plan: { task: Task; start: Date; end: Date }[] = [];
  const overflow: Task[] = [];
  for (const t of queue) {
    const need = durMin(t.meta);
    const slot = slots.find((s) => s.left >= need);
    if (!slot) {
      overflow.push(t);
      continue;
    }
    const start = new Date(slot.start);
    const end = new Date(start.getTime() + need * 60000);
    plan.push({ task: t, start, end });
    slot.start = fmtDT(end);
    slot.left -= need;
  }

  for (const p of plan) {
    await ical([
      "add",
      "--title", `[Backbeat] ${p.task.text}`,
      "--start", fmtDT(p.start),
      "--end", fmtDT(p.end),
      "--desc", `${MARKER} task:${p.task.id}`,
    ]);
  }

  const lines = plan.map((p) => `${fmtDT(p.start).slice(11)}–${fmtDT(p.end).slice(11)}  ${p.task.text} (${p.task.id})`);
  const summary = (lines.length ? lines.join("\n") : "(nothing scheduled)") +
    (overflow.length ? "\n未排入: " + overflow.map((t) => t.text).join(", ") : "");
  if (ctx.hasUI) ctx.ui.notify(`Backbeat ${date}\n${summary}`, "info");
}

// ---------- extension ----------

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const now = new Date();
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: TZ }).format(now);
    event.systemPromptOptions.sections.current_date = `${tzDateStr()} (${weekday}, ${TZ})`;
  });

  // Deterministic guard: block calendar dates that are far from today and never
  // mentioned in recent user messages (LLM date-hallucination defense).
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "calendar") return;
    const input = event.input as Record<string, unknown>;
    const userText = recentUserText(ctx);
    for (const key of ["date", "start", "end"] as const) {
      const v = input[key];
      if (typeof v !== "string") continue;
      const m = v.match(/^\d{4}-\d{2}-\d{2}/);
      const reason = m ? dateGuard(m[0], userText) : null;
      if (reason) return { block: true, reason };
    }
  });

  pi.registerTool({
    name: "tasks",
    label: "Tasks",
    description:
      "Manage the Backbeat todo pool (~/.assistant/tasks.md). Actions: add (text, due, duration, priority), list (pending/all/done), done (id), remove (id).",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("done"), Type.Literal("remove")]),
      text: Type.Optional(Type.String({ description: "task text (add)" })),
      id: Type.Optional(Type.String({ description: "task id like T01 (done/remove)" })),
      due: Type.Optional(Type.String({ description: "e.g. 今天 / 明天 / 11-28 / 周五 (add)" })),
      duration: Type.Optional(Type.String({ description: "e.g. 2h / 45m (add)" })),
      priority: Type.Optional(Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")])),
      filter: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("all"), Type.Literal("done")])),
    }),
    async execute(_id, params) {
      const tasks = parseTasks();
      switch (params.action) {
        case "add": {
          if (!params.text) return err("text required");
          const meta = [params.due ? `due:${params.due}` : "", params.duration ?? "", params.priority ?? ""].filter(Boolean).join(" | ");
          const t: Task = { id: nextId(tasks), text: params.text, meta, done: false };
          tasks.push(t);
          writeTasks(tasks);
          return ok(`Added ${fmtTask(t)}`);
        }
        case "list": {
          const f = params.filter ?? "pending";
          const list = tasks.filter((t) => (f === "all" ? true : f === "done" ? t.done : !t.done));
          return ok(list.length ? list.map(fmtTask).join("\n") : "(empty)");
        }
        case "done": {
          const t = tasks.find((x) => x.id === params.id);
          if (!t) return err(`task not found: ${params.id}`);
          t.done = true;
          if (!t.meta.includes("done:")) {
            const d = new Date();
            t.meta = `${t.meta ? t.meta + " | " : ""}done:${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          }
          writeTasks(tasks);
          return ok(`Done: ${t.id} ${t.text}`);
        }
        case "remove": {
          const i = tasks.findIndex((x) => x.id === params.id);
          if (i < 0) return err(`task not found: ${params.id}`);
          const [t] = tasks.splice(i, 1);
          writeTasks(tasks);
          return ok(`Removed ${t.id} ${t.text}`);
        }
      }
    },
  });

  pi.registerTool({
    name: "prefs",
    label: "Prefs",
    description:
      "Remember the user's standing preferences. add a fixed no-schedule block (e.g. 每天 12:00-14:00 午休); note a soft preference in words (e.g. 重要任务放上午); list shows current prefs; remove by label; forget by text. Planner's free-slot computation already honors fixed blocks; soft prefs guide LLM planning.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("remove"), Type.Literal("note"), Type.Literal("forget")]),
      days: Type.Optional(Type.String({ description: "每天/工作日/周末/周一..周日 (add)" })),
      start: Type.Optional(Type.String({ description: "HH:MM (add)" })),
      end: Type.Optional(Type.String({ description: "HH:MM (add)" })),
      label: Type.Optional(Type.String({ description: "short label like 午休 (add/remove)" })),
      text: Type.Optional(Type.String({ description: "preference in words (note/forget)" })),
    }),
    async execute(_id, params) {
      const read = () =>
        existsSync(PREFS_FILE)
          ? readFileSync(PREFS_FILE, "utf8")
          : "# Backbeat 偏好\n\n## 固定时段（不排程）\n\n## 其他偏好\n";
      switch (params.action) {
        case "list":
          return ok(read().trim());
        case "add": {
          if (!params.days || !params.start || !params.end || !params.label)
            return err("days/start/end/label required");
          const line = `- ${params.days} ${params.start}-${params.end} ${params.label}`;
          let content = read();
          if (content.includes(line)) return ok(`already remembered: ${line}`);
          content = content.replace(
            /(## 固定时段（不排程）\n)(<!--[^>]*-->\n)?/,
            `$1$2${line}\n`
          );
          writeFileSync(PREFS_FILE, content);
          return ok(`Remembered: ${line}`);
        }
        case "remove": {
          if (!params.label) return err("label required");
          const label = params.label;
          let content = read();
          const before = content;
          content = content
            .split("\n")
            .filter((l) => !l.startsWith("- ") || !l.includes(label))
            .join("\n");
          if (content === before) return err(`no preference with label: ${params.label}`);
          writeFileSync(PREFS_FILE, content);
          return ok(`Removed preference: ${params.label}`);
        }
        case "note": {
          if (!params.text) return err("text required");
          let content = read();
          if (content.includes(params.text)) return ok(`already noted: ${params.text}`);
          content = content.replace(/(## 其他偏好\n)(<!--[^>]*-->\n)?/, `$1$2- ${params.text}\n`);
          writeFileSync(PREFS_FILE, content);
          return ok(`Noted: ${params.text}`);
        }
        case "forget": {
          if (!params.text) return err("text required");
          const text = params.text;
          let content = read();
          const before = content;
          content = content
            .split("\n")
            .filter((l) => !l.startsWith("- ") || !l.includes(text))
            .join("\n");
          if (content === before) return err(`no preference matching: ${params.text}`);
          writeFileSync(PREFS_FILE, content);
          return ok(`Forgotten: ${params.text}`);
        }
      }
    },
  });

  pi.registerTool({
    name: "calendar",
    label: "Calendar",
    description:
      "Apple Calendar (iCloud) via CalDAV. Actions: day (events of a date, all calendars), free (free slots in work hours), add, move, delete, clear_ai (remove today's AI events). AI events live in the Backbeat calendar, marked [backbeat].",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("day"),
        Type.Literal("free"),
        Type.Literal("add"),
        Type.Literal("move"),
        Type.Literal("delete"),
        Type.Literal("clear_ai"),
      ]),
      date: Type.Optional(Type.String({ description: "YYYY-MM-DD, default today" })),
      title: Type.Optional(Type.String()),
      start: Type.Optional(Type.String({ description: "YYYY-MM-DDTHH:MM or HH:MM" })),
      end: Type.Optional(Type.String()),
      minutes: Type.Optional(Type.Number({ description: "duration when end omitted (add)" })),
      cal: Type.Optional(Type.String({ description: "calendar name, default Backbeat" })),
      alarm: Type.Optional(Type.Number({ description: "alarm minutes before start, default 5" })),
      desc: Type.Optional(Type.String()),
      uid: Type.Optional(Type.String()),
      match: Type.Optional(Type.String({ description: "match by summary substring" })),
      after: Type.Optional(Type.String({ description: "clear_ai: only events starting after this time" })),
    }),
    async execute(_id, params) {
      try {
        switch (params.action) {
          case "day":
            return ok(dateEcho(params.date, await ical(["day", ...(params.date ? [params.date] : [])])));
          case "free":
            return ok(dateEcho(params.date, await ical(["free", ...(params.date ? [params.date] : [])])));
          case "add": {
            if (!params.title || !params.start) return err("title and start required");
            const args = ["add", "--title", params.title, "--start", params.start];
            if (params.end) args.push("--end", params.end);
            else if (params.minutes) args.push("--minutes", String(params.minutes));
            if (params.cal) args.push("--cal", params.cal);
            if (params.alarm !== undefined) args.push("--alarm", String(params.alarm));
            if (params.desc) args.push("--desc", params.desc);
            return ok(await ical(args));
          }
          case "move": {
            if (!params.start) return err("start required");
            const args = ["move", "--start", params.start];
            if (params.uid) args.push("--uid", params.uid);
            else if (params.match) args.push("--match", params.match);
            if (params.end) args.push("--end", params.end);
            const r = await ical(args);
            logFeedback({ action: "move", start: params.start, end: params.end ?? null, result: r });
            return ok(r);
          }
          case "delete": {
            const args = ["delete"];
            if (params.uid) args.push("--uid", params.uid);
            else if (params.match) args.push("--match", params.match);
            const r = await ical(args);
            logFeedback({ action: "delete", uid: params.uid ?? null, match: params.match ?? null, result: r });
            return ok(r);
          }
          case "clear_ai":
            return ok(
              dateEcho(
                params.date,
                await ical([
                  "clear-ai",
                  ...(params.date ? [params.date] : []),
                  ...(params.after ? ["--after", params.after] : []),
                ])
              )
            );
        }
      } catch (e: any) {
        return err(e.message);
      }
    },
  });

  pi.registerCommand("plan", {
    description: "Plan the day deterministically: pending todos → free slots (priority order)",
    handler: async (_args, ctx) => {
      try {
        await runPlan(ctx, false);
      } catch (e: any) {
        if (ctx.hasUI) ctx.ui.notify(`plan failed: ${e.message}`, "error");
      }
    },
  });

  pi.registerCommand("replan", {
    description: "Re-plan the rest of today: keep started events, re-block the remaining AI events",
    handler: async (_args, ctx) => {
      try {
        await runPlan(ctx, true);
      } catch (e: any) {
        if (ctx.hasUI) ctx.ui.notify(`replan failed: ${e.message}`, "error");
      }
    },
  });
}
