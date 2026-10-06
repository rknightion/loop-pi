// Lane return cap (frozen seam S6). A `subagent-notify` message over RETURN_CAP_BYTES is replaced by
// its first HEAD_BYTES, a marker line naming where the full text is, the last ```lane-return block
// when it is not wholly inside the kept tail, and the last TAIL_BYTES. The full text is written to
// `<run dir>/returns/<run id>.md` unless pi-subagents already saved the lane's output to a file, whose
// path is named instead. Used by the loop-state extension (LLM roots) and the dispatcher.
//
// The saved-output path comes only from pi-subagents' structured completion (the async-complete
// payload's single result `savedOutputPath`, matched to the notify by its async directory line), or
// from a reference-only marker that is the first line of the lane's output. Never from free text in
// the return body: a lane can write any line there, and a wrong path loses the full text.
//
// pi-subagents 0.76.1 appends an idle root's notify with no extension `message_end`, so the root
// cannot cap it there. Every lane therefore caps its own final text first (`capLaneAssistantMessage`,
// loop-guard's lane entry) to LANE_RETURN_CAP_BYTES, leaving room under RETURN_CAP_BYTES for the
// notify's own lines, and writes the full text to `<run dir>/returns/lane-<key>-<hash>.md`.
//
// Pure apart from `capNotifyContent`'s and `capLaneAssistantMessage`'s file writes. Nothing here
// parses the `return` event: callers parse it from the async-complete payload, which is the lane's
// own (lane-capped) output, before the root message is rewritten.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export const NOTIFY_CUSTOM_TYPE = "subagent-notify";
export const RETURN_CAP_BYTES = 16_384;
export const HEAD_BYTES = 6_144;
export const TAIL_BYTES = 8_192;
/** A lane's final text over this is capped in the lane; the rest of RETURN_CAP_BYTES is the notify's framing. */
export const LANE_RETURN_CAP_BYTES = RETURN_CAP_BYTES - 2_048;
/** The lane's head and tail, leaving LANE_RETURN_CAP_BYTES room for the marker and a block outside the tail. */
export const LANE_HEAD_BYTES = 4_096;
export const LANE_TAIL_BYTES = 6_144;

const LANE_RETURN_RE = /```lane-return[^\n]*\n[\s\S]*?```/g;

/** The first `n` bytes of `buf`, never ending inside a UTF-8 sequence. */
function headBytes(buf: Buffer, n: number): Buffer {
  let end = Math.min(n, buf.length);
  if (end < buf.length) {
    // Step back over continuation bytes, then over the lead byte whose sequence would be cut.
    let i = end;
    while (i > 0 && (buf[i] & 0xc0) === 0x80) i--;
    end = i;
  }
  return buf.subarray(0, end);
}

/** The last `n` bytes of `buf`, never starting inside a UTF-8 sequence. */
function tailBytes(buf: Buffer, n: number): Buffer {
  let start = Math.max(0, buf.length - n);
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

/** The last ```lane-return block in `text` with its byte offsets, or null. */
export function lastLaneReturnBlock(text: string): { block: string; start: number; end: number } | null {
  let found: { block: string; index: number } | null = null;
  LANE_RETURN_RE.lastIndex = 0;
  for (let m = LANE_RETURN_RE.exec(text); m !== null; m = LANE_RETURN_RE.exec(text)) found = { block: m[0], index: m.index };
  if (!found) return null;
  const start = Buffer.byteLength(text.slice(0, found.index), "utf8");
  return { block: found.block, start, end: start + Buffer.byteLength(found.block, "utf8") };
}

export function markerLine(omitted: number, fullPath: string): string {
  return `[... ${omitted} bytes omitted; full return: ${fullPath} ...]`;
}

/**
 * The capped form of `text`, or null when it is within `limit`. `fullPath` is named in the marker line.
 * A head cut inside the last block ends before the block instead, so no unclosed opener precedes it.
 */
export function capText(
  text: string,
  fullPath: string,
  limit = RETURN_CAP_BYTES,
  sizes: { head: number; tail: number } = { head: HEAD_BYTES, tail: TAIL_BYTES },
): string | null {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= limit) return null;
  const block = lastLaneReturnBlock(text);
  let head = headBytes(buf, sizes.head);
  if (block && block.start < head.length && block.end > head.length) head = buf.subarray(0, block.start);
  const tail = tailBytes(buf, sizes.tail);
  const tailStart = buf.length - tail.length;
  const omitted = buf.length - head.length - tail.length;
  const parts = [head.toString("utf8"), markerLine(omitted, fullPath)];
  if (block && block.start < tailStart) parts.push(block.block);
  parts.push(tail.toString("utf8"));
  return parts.join("\n");
}

/** The text of a custom message's content (a string or text blocks). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The async directory a pi-subagents completion names. Its correlation lines follow the result body,
 *  so the last `Retention-managed async directory:` line is pi-subagents' own. */
export function asyncDirFromNotify(text: string): string | null {
  const re = /^Retention-managed async directory: (.+)$/gm;
  let last: string | null = null;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m[1].trim();
  return last;
}

/** The async run id a pi-subagents completion names: the basename of its (last) async directory line. */
export function runIdFromNotify(text: string): string | null {
  const dir = asyncDirFromNotify(text);
  if (!dir) return null;
  const id = basename(dir);
  return RUN_ID_RE.test(id) ? id : null;
}

/** What pi-subagents' structured completion says about one run. */
export interface CompletionInfo {
  runId: string;
  asyncDir: string | null;
  /** The single result's saved output file, or null (none, several results, or not absolute). */
  savedOutputPath: string | null;
}

/** The structured facts of a `subagent:async-complete` payload, or null without a run id. */
export function completionInfo(data: unknown): CompletionInfo | null {
  const d = data as { runId?: unknown; id?: unknown; asyncDir?: unknown; results?: unknown } | null;
  const runId = typeof d?.runId === "string" ? d.runId : typeof d?.id === "string" ? d.id : null;
  if (!runId || !RUN_ID_RE.test(runId)) return null;
  const asyncDir = typeof d?.asyncDir === "string" && isAbsolute(d.asyncDir) ? d.asyncDir : null;
  const results = Array.isArray(d?.results) ? (d.results as Record<string, unknown>[]) : [];
  let saved: string | null = null;
  if (results.length === 1 && results[0] && typeof results[0] === "object") {
    const r = results[0];
    const ref = r.outputReference as { path?: unknown } | string | undefined;
    const candidate = typeof r.savedOutputPath === "string" ? r.savedOutputPath : typeof ref === "string" ? ref : typeof ref?.path === "string" ? ref.path : null;
    if (candidate && isAbsolute(candidate)) saved = candidate;
  }
  return { runId, asyncDir, savedOutputPath: saved };
}

const MARKER_RE = /^Output saved to: (\/.+?) \(\d[^()]*, \d+ lines?\)\. Read this file if needed\.$/;
const NOTIFY_HEADER_RE = /^(?:Background task|Detached foreground task) (?:completed|failed|paused|stopped): \*\*.+?\*\*/;

/**
 * The saved-output file named by a reference-only marker that is the first line of the lane's output:
 * the first line of the text, or (in a pi-subagents completion) the first non-empty line after the
 * header, after an optional `<agent>:` line. A marker anywhere else is body text and is ignored.
 */
export function firstLineSavedOutput(text: string): string | null {
  const lines = text.split("\n");
  let i = 0;
  if (NOTIFY_HEADER_RE.test(lines[0] ?? "")) {
    i = 1;
    while (i < lines.length && lines[i].trim() === "") i++;
    if (/^[A-Za-z0-9][\w.-]*:$/.test(lines[i] ?? "")) i++;
  }
  const m = MARKER_RE.exec((lines[i] ?? "").trimEnd());
  return m ? m[1] : null;
}

function isFile(path: string | null): path is string {
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Cap one notify message's text. Returns the replacement text and where the full text is, or null
 * when the text is within the cap, there is no run dir, or the full text could not be kept (an
 * uncapped message is better than a capped one whose full text is lost).
 */
export function capNotifyContent(
  text: string,
  runDir: string | undefined,
  completion?: (runId: string) => CompletionInfo | undefined,
): { text: string; fullPath: string } | null {
  if (Buffer.byteLength(text, "utf8") <= RETURN_CAP_BYTES) return null;
  if (!runDir || !existsSync(runDir)) return null;
  const runId = runIdFromNotify(text);
  const known = runId ? completion?.(runId) : undefined;
  // The structured completion must be the one this notify's own async directory line names.
  const structured = known && (known.asyncDir === null || known.asyncDir === asyncDirFromNotify(text)) ? known.savedOutputPath : null;
  let fullPath: string | null = isFile(structured) ? structured : null;
  if (!fullPath) {
    const marker = firstLineSavedOutput(text);
    if (isFile(marker)) fullPath = marker;
  }
  if (!fullPath) {
    const id = runId ?? `notify-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
    const dir = join(runDir, "returns");
    fullPath = join(dir, `${id}.md`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, text);
    } catch {
      return null;
    }
  }
  const capped = capText(text, fullPath);
  return capped === null ? null : { text: capped, fullPath };
}

/** The capped replacement for a `subagent-notify` custom message, or undefined to leave it alone. */
export function capNotifyMessage<M extends { role?: string; customType?: string; content?: unknown }>(
  message: M,
  runDir: string | undefined,
  completion?: (runId: string) => CompletionInfo | undefined,
): M | undefined {
  if (message.role !== "custom" || message.customType !== NOTIFY_CUSTOM_TYPE) return undefined;
  const capped = capNotifyContent(contentText(message.content), runDir, completion);
  return capped ? { ...message, content: capped.text } : undefined;
}

type AssistantPart = { type?: string; text?: unknown };

/**
 * The capped replacement for a lane's final assistant message, or undefined to leave it alone: a
 * message that calls a tool or ended in error, a last non-empty text part within
 * LANE_RETURN_CAP_BYTES, no run dir, or a full copy that could not be written. Only that last text
 * part is capped, in place and without its text signature: it is the output pi-subagents'
 * `getFinalOutput` returns for the run. Every other part is left as it was.
 */
export function capLaneAssistantMessage<M extends { role?: string; content?: unknown; stopReason?: unknown }>(
  message: M,
  runDir: string | undefined,
  key: string,
): M | undefined {
  if (message.role !== "assistant" || message.stopReason === "error" || !Array.isArray(message.content)) return undefined;
  const parts = message.content as AssistantPart[];
  if (parts.some((p) => p?.type === "toolCall")) return undefined;
  let index = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type === "text" && typeof parts[i].text === "string" && (parts[i].text as string).trim()) {
      index = i;
      break;
    }
  }
  if (index < 0) return undefined;
  const text = parts[index].text as string;
  if (Buffer.byteLength(text, "utf8") <= LANE_RETURN_CAP_BYTES) return undefined;
  if (!runDir || !existsSync(runDir)) return undefined;
  const dir = join(runDir, "returns");
  const safeKey = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "lane";
  const fullPath = join(dir, `lane-${safeKey}-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, text);
  } catch {
    return undefined;
  }
  const capped = capText(text, fullPath, LANE_RETURN_CAP_BYTES, { head: LANE_HEAD_BYTES, tail: LANE_TAIL_BYTES });
  if (capped === null) return undefined;
  const content = parts.map((p, i) => (i === index ? { type: "text", text: capped } : p));
  return { ...message, content };
}
