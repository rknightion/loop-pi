// Lane return cap (frozen seam S6). A `subagent-notify` message over RETURN_CAP_BYTES is replaced by
// its first HEAD_BYTES, a marker line naming where the full text is, the last ```lane-return block
// when it is not wholly inside the kept tail, and the last TAIL_BYTES. The full text is written to
// `<run dir>/returns/<run id>.md` unless pi-subagents already saved the lane's output to a file, whose
// path is named instead. Used by the loop-state extension (LLM roots) and the dispatcher.
//
// Pure apart from `capNotifyContent`'s file write. Nothing here parses the `return` event: callers
// parse it from the full text (the async-complete payload) before the message is rewritten.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const NOTIFY_CUSTOM_TYPE = "subagent-notify";
export const RETURN_CAP_BYTES = 16_384;
export const HEAD_BYTES = 6_144;
export const TAIL_BYTES = 8_192;

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

/** The capped form of `text`, or null when it is within the cap. `fullPath` is named in the marker line. */
export function capText(text: string, fullPath: string): string | null {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= RETURN_CAP_BYTES) return null;
  const head = headBytes(buf, HEAD_BYTES);
  const tail = tailBytes(buf, TAIL_BYTES);
  const tailStart = buf.length - tail.length;
  const omitted = buf.length - head.length - tail.length;
  const parts = [head.toString("utf8"), markerLine(omitted, fullPath)];
  const block = lastLaneReturnBlock(text);
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

/** The async run id a pi-subagents completion names: the basename of its async directory line. */
export function runIdFromNotify(text: string): string | null {
  const m = /^Retention-managed async directory: (.+)$/m.exec(text);
  if (m) {
    const id = basename(m[1].trim());
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return id;
  }
  return null;
}

/** The saved-output file pi-subagents reported (`Output saved to: <abs> (...)`), when it exists. */
export function savedOutputPath(text: string): string | null {
  const re = /Output saved to: (\/[^\n]*?) \(\d/g;
  let last: string | null = null;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m[1];
  if (!last) return null;
  try {
    return statSync(last).isFile() ? last : null;
  } catch {
    return null;
  }
}

/**
 * Cap one notify message's text. Returns the replacement text and where the full text is, or null
 * when the text is within the cap, there is no run dir, or the full text could not be kept (an
 * uncapped message is better than a capped one whose full text is lost).
 */
export function capNotifyContent(text: string, runDir: string | undefined): { text: string; fullPath: string } | null {
  if (Buffer.byteLength(text, "utf8") <= RETURN_CAP_BYTES) return null;
  if (!runDir || !existsSync(runDir)) return null;
  let fullPath = savedOutputPath(text);
  if (!fullPath) {
    const id = runIdFromNotify(text) ?? `notify-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
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
): M | undefined {
  if (message.role !== "custom" || message.customType !== NOTIFY_CUSTOM_TYPE) return undefined;
  const capped = capNotifyContent(contentText(message.content), runDir);
  return capped ? { ...message, content: capped.text } : undefined;
}
