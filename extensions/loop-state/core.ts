// Pure helpers for the loop-state extension: brief header parsing, lane-return parsing, and the
// state log path. No pi imports, so they are unit-testable on their own.

export interface Brief {
  lane: string;
  task: string;
  tier: "routine" | "guarded";
  deadline?: string;
}

const HEADER_RE = /^Lane:\s*(\S+?)\s*·\s*Task:\s*(\S+?)(?:\s*\([^·]*\))?\s*·\s*Tier:\s*(routine|guarded)\b/;

/** The brief's first non-empty line is `Lane: <id> · Task: <id> [(<title>)] · Tier: routine|guarded`. */
export function parseBrief(text: unknown): Brief | null {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  const first = lines.find((line) => line.trim() !== "");
  if (first === undefined) return null;
  const m = HEADER_RE.exec(first.trim());
  if (!m) return null;
  const brief: Brief = { lane: m[1], task: m[2], tier: m[3] as Brief["tier"] };
  const deadline = lines.map((l) => /^Deadline:\s*(\S+)\s*$/.exec(l.trim())).find((x) => x !== null);
  if (deadline) brief.deadline = deadline[1];
  return brief;
}

/** `report-<name>.md` becomes `state-<name>.jsonl` in the same directory. Null for any other name. */
export function deriveLogPath(reportPath: string): string | null {
  const slash = reportPath.lastIndexOf("/");
  const dir = slash >= 0 ? reportPath.slice(0, slash + 1) : "";
  const base = reportPath.slice(slash + 1);
  const m = /^report-(.+)\.md$/.exec(base);
  return m ? `${dir}state-${m[1]}.jsonl` : null;
}

/** The run id in pi-subagents' launch result text, `Async: <agent> [<id>]`. */
export function runIdFromText(text: string): string | null {
  const m = /Async[^:\n]*:[^\[\n]*\[([^\]\s]+)\]/.exec(text);
  return m ? m[1] : null;
}

const STATUSES = new Set(["complete", "partial", "blocked", "failed"]);

/** The last ```lane-return block that holds a JSON object, v2 or legacy without `v`. */
export function parseLaneReturn(text: string): Record<string, unknown> | null {
  const re = /```lane-return[^\n]*\n([\s\S]*?)```/g;
  let last: Record<string, unknown> | null = null;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    try {
      const parsed: unknown = JSON.parse(m[1]);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const v = (parsed as Record<string, unknown>).v;
        if (v === undefined || v === 2) last = parsed as Record<string, unknown>;
      }
    } catch {
      // A malformed block is ignored; the notify status stands.
    }
  }
  return last;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

/** The `return` event for a finished run. The status is the block's: a run with no block, or with
 *  a block whose status is not one of the four, is `failed` whatever pi-subagents reported, as the
 *  dispatcher's parseLaneReturn reads it. Fields of a block that do not fit the schema are dropped. */
export function returnEvent(lane: string, run: string, block: Record<string, unknown> | null): Record<string, unknown> {
  const ev: Record<string, unknown> = { ev: "return", lane, run };
  const fromBlock = block && typeof block.status === "string" && STATUSES.has(block.status) ? block.status : null;
  ev.status = fromBlock ?? "failed";
  if (!block) return ev;
  if (block.sha === null || isStr(block.sha)) ev.sha = block.sha;
  if (typeof block.landed === "boolean") ev.landed = block.landed;
  if (isStr(block.check)) ev.check = block.check;
  if (block.exit === null || isInt(block.exit)) ev.exit = block.exit;
  if (block.ci === null || isStr(block.ci)) ev.ci = block.ci;
  else if (isInt(block.ci)) ev.ci = String(block.ci);
  const cr = block.coderabbit as Record<string, unknown> | null | undefined;
  if (cr === null) ev.coderabbit = null;
  else if (cr && typeof cr.ran === "boolean" && isInt(cr.major) && isInt(cr.unreviewed)) {
    ev.coderabbit = { ran: cr.ran, major: cr.major, unreviewed: cr.unreviewed };
  }
  if (isStr(block.base)) ev.base = block.base;
  if (Array.isArray(block.questions) && block.questions.every((q) => typeof q === "string")) {
    ev.questions = block.questions;
  }
  return ev;
}
