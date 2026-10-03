// Pure command parsing and rule evaluation for loop-guard.
//
// This module has no side effects and no pi imports: everything here is plain
// string/array logic so it can be table-tested without a pi runtime. root.ts and
// lane.ts own the stateful wiring (tool_call handlers, hook-script adapter,
// async-run tracking) and call into these pure functions for the actual verdict.
//
// Stated honestly (SEAMS.md): this is an honest-mistake fence against
// plainly typed commands, not a security boundary.
//
// Design decision: the guard exists only to stop genuinely
// dangerous actions (force/destructive pushes, bulk add/commit, background
// detach; for lanes also secret-store writes, `gh release create` and
// mutating `gh api`). Inline interpreters are not
// blocked as such, and input the parser cannot read is neither failed closed
// nor warned about: it gets a conservative text scan (fallbackScan) that blocks
// only when a dangerous pattern literally appears. The parser below unwraps the
// common obfuscations named in the plan (env/nice/timeout/xargs wrappers, `bash -c`,
// `$(...)`/backtick substitution) but is not a full POSIX shell grammar. Redirection
// operators (`>`, `>>`, `<`) are dropped rather than fully parsed, which is safe for
// the checks below (they scan for specific subcommands/flags, not "no unknown
// tokens") but means a redirect target that happens to look like a flag is inert
// noise, never a false negative on the rules we do check. Heredocs and
// here-strings are cut out by a quote-aware pre-pass (stripHeredocs) before any
// other stage sees the text; their bodies are then treated by the command that
// receives them (see parseCommand).

import type { OpsEntry } from "./ops.ts";

export type Role = "root" | "lane";

export interface Decision {
  /** True when the call must be blocked. */
  block: boolean;
  /** Model-facing reason, set whenever block is true. */
  reason?: string;
  /** Retained for root.ts's notify path. The rules never set it since the
   *  Design decision: unparseable input gets the fallback scan and
   *  is either blocked or allowed silently. */
  warning?: string;
}

function allow(): Decision {
  return { block: false };
}

function block(reason: string): Decision {
  return { block: true, reason };
}

// ---------------------------------------------------------------------------
// The C3 agent set (SEAMS.md "Names and paths"): the only names the root may
// spawn. Frozen; a change here means re-freezing SEAMS.md first.
// ---------------------------------------------------------------------------
export const C3_AGENTS: ReadonlySet<string> = new Set([
  "mapper",
  "mapper-deep",
  "gate-runner",
  "lane-worker",
  "lane-worker-push",
  "lane-worker-retry",
  "lane-worker-retry-push",
  "complex-worker",
  "complex-worker-push",
  "reviewer",
  "reviewer-high",
  "security-reviewer",
  "rescue-sol",
  "rescue-astra",
  "lane-worker-low",
  "lane-worker-low-push",
  "triager",
  "ops",
]);

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/** `target` is set on a `redir` op: the word a redirection writes to (`>`, `>>`, `>|`, `&>`,
 *  `<>`, `N>&M`). Input redirections carry no target. */
type Op = { op: string; target?: string };
type Token = string | Op;

function isOp(tok: Token): tok is Op {
  return typeof tok === "object" && tok !== null && "op" in tok;
}

/** Lex one shell command string into words and control operators.
 *
 * Recognises `;`, `&&`, `||`, `|`, `\n`, a bare background `&` and unquoted
 * `(` / `)` (subshells, function definitions, case arms) as operators.
 * Redirect operators (`<`, `>`, `>>`, `>|`, `<>`) and their file word become one
 * `redir` op (carrying the target for a write), never a command word; an
 * unquoted all-digit word written right before the operator is its fd number
 * and is dropped with it. An `&` immediately adjacent to `>` (covers `>&`, `&>`,
 * `N>&M`) is treated as part of a redirect, never as the background operator. Heredocs
 * and here-strings are replaced by placeholder words in stripHeredocs before
 * this runs; a `<<` that still reaches the lexer means the pre-pass did not
 * recognise it and fails the lex (return null): the caller falls back to the
 * text scan.
 */
function lex(command: string): Token[] | null {
  const tokens: Token[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  // Set after a redirection operator: the next word is its file, not a command word.
  let redirect: "in" | "out" | null = null;
  // The current word has (or had) quoted characters: never an fd number.
  let wordQuoted = false;
  let i = 0;
  const n = command.length;

  const flush = () => {
    if (started) {
      if (redirect) tokens.push({ op: "redir", ...(redirect === "out" ? { target: word } : {}) });
      else tokens.push(word);
      redirect = null;
      word = "";
      started = false;
      wordQuoted = false;
    }
  };
  const pushOp = (op: string) => {
    redirect = null;
    tokens.push({ op });
  };
  /** At a redirection operator: drop an adjacent unquoted fd number, else end the word. */
  const startRedirect = (mode: "in" | "out") => {
    if (started && !wordQuoted && !redirect && /^[0-9]+$/.test(word)) {
      word = "";
      started = false;
    } else {
      flush();
    }
    redirect = mode === "out" || redirect === "out" ? "out" : "in";
  };

  while (i < n) {
    const c = command[i];
    if (quote) {
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      if (c === "\\" && quote === '"' && i + 1 < n && '$`"\\\n'.includes(command[i + 1])) {
        i++;
        if (command[i] !== "\n") {
          word += command[i];
          started = true;
        }
        i++;
        continue;
      }
      word += c;
      started = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c as '"' | "'";
      started = true;
      wordQuoted = true;
      i++;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= n) return null; // trailing escape
      i++;
      if (command[i] !== "\n") {
        word += command[i];
        started = true;
        wordQuoted = true;
      }
      i++;
      continue;
    }
    if (c === "#" && !started) {
      const nl = command.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      flush();
      i++;
      continue;
    }
    if (c === "\n") {
      flush();
      pushOp("\n");
      i++;
      continue;
    }
    if (c === ";") {
      flush();
      pushOp(";");
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      flush();
      pushOp(c);
      i++;
      continue;
    }
    if (c === "|") {
      flush();
      if (command[i + 1] === "|") {
        pushOp("||");
        i += 2;
      } else {
        pushOp("|");
        i += 1;
      }
      continue;
    }
    if (c === "&") {
      const prev = i > 0 ? command[i - 1] : "";
      const next = command[i + 1] ?? "";
      if (prev === ">" || prev === "<" || next === ">") {
        // Part of a redirect (`>&`, `<&`, `&>`, `N>&M`), never a background operator.
        if (next === ">") flush();
        i += 1;
        continue;
      }
      flush();
      if (next === "&") {
        pushOp("&&");
        i += 2;
        continue;
      }
      pushOp("&");
      i += 1;
      continue;
    }
    if (c === "<") {
      if (command[i + 1] === "<") return null; // heredoc unsupported
      startRedirect("in");
      i += 1;
      continue;
    }
    if (c === ">") {
      startRedirect("out");
      i += 1;
      if (command[i] === ">" || command[i] === "|") i += 1; // >> and >|
      continue;
    }
    word += c;
    started = true;
    i++;
  }
  if (quote) return null; // unterminated quote
  flush();
  if (redirect) tokens.push({ op: "redir" }); // operator with no file word: keep it out of every segment
  return tokens;
}

/** Split lexed tokens into segments at `;`, `&&`, `||`, `|`, newline, `&`,
 *  `(` and `)`.
 *  Returns the segments, whether each one pipes its stdout into the next
 *  (`pipesToNext[i]`), whether a bare background `&` operator occurred, and
 *  every file a redirection writes to. */
function splitSegments(tokens: Token[]): {
  segments: string[][];
  pipesToNext: boolean[];
  hasBackground: boolean;
  writeTargets: string[];
} {
  const segments: string[][] = [];
  const pipesToNext: boolean[] = [];
  const writeTargets: string[] = [];
  let current: string[] = [];
  let hasBackground = false;
  const SEPARATORS = new Set([";", "&&", "||", "|", "\n", "&", "(", ")"]);
  for (const tok of tokens) {
    if (isOp(tok) && tok.op === "redir") {
      if (tok.target !== undefined) writeTargets.push(tok.target);
    } else if (isOp(tok) && SEPARATORS.has(tok.op)) {
      if (tok.op === "&") hasBackground = true;
      if (current.length) {
        segments.push(current);
        pipesToNext.push(tok.op === "|");
      }
      current = [];
    } else if (!isOp(tok)) {
      current.push(tok);
    }
  }
  if (current.length) {
    segments.push(current);
    pipesToNext.push(false);
  }
  return { segments, pipesToNext, hasBackground, writeTargets };
}

// ---------------------------------------------------------------------------
// Heredocs (`<<WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD`, `<<-WORD`) and
// here-strings (`<<<word`), first-live-loop fix.
//
// stripHeredocs runs on the raw text before every other stage. It tracks shell
// quoting (single, double, ANSI-C `$'...'`, backslash), `$(...)`/`(...)`/
// backtick nesting and comments, so a `<<` inside a string is never taken for
// an operator. Each unquoted heredoc operator and its delimiter word become a
// placeholder word; at the next unquoted newline the pending bodies are cut
// out line by line up to their exact delimiter line (after leading-tab
// stripping for `<<-`). A heredoc with no delimiter line before the end of the
// input is unterminated and fails the parse (bash would accept it with a
// warning; this fence fails closed instead). Each `<<<` becomes a marker word
// immediately before the here-string's own word, which stays in the text so
// the normal stages still extract any substitution inside it.
//
// The bodies live in a ParseContext shared across one whole parse tree, so a
// placeholder inside a `$(...)` resolves after extraction. parseCommand then
// decides what a body means from the command that receives it.
// ---------------------------------------------------------------------------

interface HeredocBody {
  body: string;
  /** Delimiter had any quoting: the body is literal, no expansion at all. */
  quoted: boolean;
}

interface ParseContext {
  heredocs: HeredocBody[];
}

// The parser's own placeholder words are NUL-delimited. No typed command can contain NUL (it is
// refused up front), and quote splicing cannot produce one, so they can never be forged.
const NUL = "\u0000";
const HEREDOC_PLACEHOLDER = /^\u0000heredoc_(\d+)\u0000$/;
const HERESTRING_MARKER = `${NUL}herestring${NUL}`;

type ScanContext = "sq" | "dq" | "ansi" | "bt" | "subst" | "paren";

/** Characters that end an unquoted heredoc delimiter word. */
const WORD_BREAK = " \t\r\n;&|()<>";
/** Characters after which an unquoted `#` starts a comment. Deliberately
 *  narrower than bash where unsure: a `#` wrongly kept is harmless text, a
 *  `#` wrongly taken as a comment would hide the rest of the line. */
const COMMENT_MAY_FOLLOW = " \t\r\n;&|(";

function stripHeredocs(command: string, ctx: ParseContext): string | null {
  let out = "";
  const stack: ScanContext[] = [];
  const pending: { index: number; delim: string; stripTabs: boolean }[] = [];
  let atWordStart = true;
  let i = 0;
  const n = command.length;

  /** Reads the heredoc delimiter word starting at `j` (after `<<`/`<<-` and
   *  blanks). Any quoting anywhere in the word makes the body literal. */
  const readDelimiter = (start: number): { delim: string; quoted: boolean; next: number } | null => {
    let j = start;
    let delim = "";
    let quoted = false;
    while (j < n) {
      const d = command[j];
      if (WORD_BREAK.includes(d)) break;
      if (d === "'") {
        const end = command.indexOf("'", j + 1);
        if (end < 0) return null;
        delim += command.slice(j + 1, end);
        quoted = true;
        j = end + 1;
        continue;
      }
      if (d === '"') {
        let k = j + 1;
        while (k < n && command[k] !== '"') {
          if (command[k] === "\\" && k + 1 < n && '$`"\\\n'.includes(command[k + 1])) k++;
          delim += command[k];
          k++;
        }
        if (k >= n) return null;
        quoted = true;
        j = k + 1;
        continue;
      }
      if (d === "\\") {
        if (j + 1 >= n) return null;
        delim += command[j + 1];
        quoted = true;
        j += 2;
        continue;
      }
      // A substitution-shaped delimiter is never a plain mistake; refuse it.
      if (d === "`" || (d === "$" && (command[j + 1] === "(" || command[j + 1] === "'"))) return null;
      delim += d;
      j++;
    }
    if (delim.length === 0) return null;
    return { delim, quoted, next: j };
  };

  /** Consumes one heredoc body starting at `start` (the first body line).
   *  Returns the body and the index just past its delimiter line. */
  const readBody = (start: number, delim: string, stripTabs: boolean): { body: string; next: number } | null => {
    const lines: string[] = [];
    let pos = start;
    while (pos <= n) {
      if (pos === n) return null; // no delimiter line: unterminated
      const nl = command.indexOf("\n", pos);
      const lineEnd = nl < 0 ? n : nl;
      let line = command.slice(pos, lineEnd);
      if (stripTabs) line = line.replace(/^\t+/, "");
      if (line === delim) return { body: lines.join("\n"), next: nl < 0 ? n : nl + 1 };
      lines.push(line);
      if (nl < 0) return null;
      pos = nl + 1;
    }
    return null;
  };

  while (i < n) {
    const c = command[i];
    const top = stack[stack.length - 1];

    if (top === "sq") {
      out += c;
      if (c === "'") stack.pop();
      i++;
      continue;
    }
    if (top === "ansi") {
      if (c === "\\" && i + 1 < n) {
        out += c + command[i + 1];
        i += 2;
        continue;
      }
      out += c;
      if (c === "'") stack.pop();
      i++;
      continue;
    }
    if (top === "dq") {
      if (c === "\\" && i + 1 < n) {
        out += c + command[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') stack.pop();
      else if (c === "$" && command[i + 1] === "(") {
        stack.push("subst");
        out += "$(";
        i += 2;
        atWordStart = true;
        continue;
      } else if (c === "`") {
        stack.push("bt");
        out += c;
        i++;
        atWordStart = true;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    // Unquoted: top level, inside $(...), (...) or backticks.
    if (c === "\\") {
      out += i + 1 < n ? c + command[i + 1] : c;
      i += 2;
      atWordStart = false;
      continue;
    }
    if (c === "#" && atWordStart) {
      // A comment runs to the end of the line; it is dropped (the lexer drops
      // it too), so an apostrophe in it cannot unbalance a later stage.
      const nl = command.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        out += ` ${HERESTRING_MARKER} `;
        i += 3;
        atWordStart = true;
        continue;
      }
      let j = i + 2;
      let stripTabs = false;
      if (command[j] === "-") {
        stripTabs = true;
        j++;
      }
      while (j < n && (command[j] === " " || command[j] === "\t")) j++;
      const word = readDelimiter(j);
      if (!word) return null;
      const index = ctx.heredocs.length;
      ctx.heredocs.push({ body: "", quoted: word.quoted });
      pending.push({ index, delim: word.delim, stripTabs });
      out += ` ${NUL}heredoc_${index}${NUL} `;
      i = word.next;
      atWordStart = true;
      continue;
    }
    if (c === "\n") {
      out += c;
      i++;
      atWordStart = true;
      while (pending.length) {
        const h = pending.shift()!;
        const read = readBody(i, h.delim, h.stripTabs);
        if (!read) return null;
        ctx.heredocs[h.index].body = read.body;
        i = read.next;
      }
      continue;
    }
    if (c === "'") {
      stack.push("sq");
    } else if (c === "$" && command[i + 1] === "'") {
      stack.push("ansi");
      out += "$'";
      i += 2;
      atWordStart = false;
      continue;
    } else if (c === '"') {
      stack.push("dq");
    } else if (c === "`") {
      if (top === "bt") stack.pop();
      else {
        stack.push("bt");
        out += c;
        i++;
        atWordStart = true;
        continue;
      }
    } else if (c === "$" && command[i + 1] === "(") {
      stack.push("subst");
      out += "$(";
      i += 2;
      atWordStart = true;
      continue;
    } else if (c === "(") {
      stack.push("paren");
    } else if (c === ")") {
      if (top === "subst" || top === "paren") stack.pop();
    }
    out += c;
    i++;
    // Only a blank or a command-separating character starts a new word. After
    // a closing `)`, backtick or quote the word continues, so a `#` there is
    // literal text, never a comment (`$(true)# ; cmd` still runs `cmd`).
    atWordStart = COMMENT_MAY_FOLLOW.includes(c);
  }

  if (stack.length || pending.length) return null;
  return out;
}

/** The `$(...)` and backtick commands inside an UNQUOTED-delimiter heredoc
 *  body, which the outer shell runs whatever command receives the body.
 *  Quotes are not special in a heredoc body (`'$(x)'` still runs `x`); only a
 *  backslash escapes. Null when a substitution is unbalanced. */
function extractBodySubstitutions(body: string): string[] | null {
  const inner: string[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "$" && body[i + 1] === "(") {
      const start = i + 2;
      let depth = 1;
      let j = start;
      while (j < n && depth > 0) {
        if (body[j] === "(") depth++;
        else if (body[j] === ")") depth--;
        if (depth > 0) j++;
      }
      if (depth !== 0) return null;
      inner.push(body.slice(start, j));
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n && body[j] !== "`") j += body[j] === "\\" ? 2 : 1;
      if (j >= n) return null;
      inner.push(body.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    i++;
  }
  return inner;
}

/** What a shell reading an unquoted-delimiter body actually receives: the
 *  outer shell removes `\` before `$`, backtick and `\`, and drops `\`-newline
 *  (so `\$(x)` reaches the inner shell as a live `$(x)`). */
function unescapeHeredocBody(body: string): string {
  return body.replace(/\\([$`\\\n])/g, (_m, ch: string) => (ch === "\n" ? "" : ch));
}

// ---------------------------------------------------------------------------
// $(...) and backtick substitution extraction (C4 item 5: "inspect $(...) and
// backtick contents"). Scans the raw string tracking quote state.
//
// Only a single quote makes shell content literal: `'$(...)' ` and `` '`...`' ``
// are real shell text, never expanded, so they are left alone. A DOUBLE quote
// does NOT suppress `$(...)`/backtick expansion (matching real shell
// semantics: `echo "$(git push --force)"` runs the substitution), so this
// scans and extracts them from inside double quotes too, correcting an
// earlier version of this function that wrongly treated both quote kinds as
// literal (course correction, main thread, 2026-09-27) - that version let
// `echo "$(git push --force)"` and `` echo "`nohup x &`" `` past every check.
//
// Replaces each top-level substitution with an inert placeholder word and
// returns the extracted inner command texts for recursive parsing.
// ---------------------------------------------------------------------------

function extractSubstitutions(command: string): { text: string; inner: string[] } | null {
  let out = "";
  const inner: string[] = [];
  let quote: '"' | "'" | null = null;
  let i = 0;
  const n = command.length;
  let placeholderIndex = 0;

  const extractDollarParen = (): boolean => {
    // Precondition: command[i] is "$", "<" or ">" and command[i+1] === "(".
    const start = i + 2;
    let depth = 1;
    let j = start;
    while (j < n && depth > 0) {
      if (command[j] === "(") depth++;
      else if (command[j] === ")") depth--;
      if (depth > 0) j++;
    }
    if (depth !== 0) return false; // unbalanced
    inner.push(command.slice(start, j));
    out += `${NUL}subst_${placeholderIndex++}${NUL}`;
    i = j + 1;
    return true;
  };

  const extractBacktick = (): boolean => {
    // Precondition: command[i] === "`".
    const end = command.indexOf("`", i + 1);
    if (end < 0) return false; // unterminated
    inner.push(command.slice(i + 1, end));
    out += `${NUL}subst_${placeholderIndex++}${NUL}`;
    i = end + 1;
    return true;
  };

  while (i < n) {
    const c = command[i];
    if (quote === "'") {
      // Single quotes: fully literal, no escapes, no substitution.
      out += c;
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === "\\" && i + 1 < n) {
        out += c + command[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') {
        out += c;
        quote = null;
        i++;
        continue;
      }
      if (c === "$" && command[i + 1] === "(") {
        if (!extractDollarParen()) return null;
        continue;
      }
      if (c === "`") {
        if (!extractBacktick()) return null;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    // Unquoted.
    if (c === "'" || c === '"') {
      quote = c as '"' | "'";
      out += c;
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      out += c + command[i + 1];
      i += 2;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      if (!extractDollarParen()) return null;
      continue;
    }
    if ((c === "<" || c === ">") && command[i + 1] === "(") {
      // Process substitution `<(...)`/`>(...)` (unquoted only): the inner
      // command runs, so it is extracted and evaluated like `$(...)`. The
      // leading `<`/`>` is consumed with it, never left as a redirect.
      if (!extractDollarParen()) return null;
      continue;
    }
    if (c === "`") {
      if (!extractBacktick()) return null;
      continue;
    }
    out += c;
    i++;
  }
  if (quote) return null;
  return { text: out, inner };
}

/** Defense in depth for the extraction above: after replacing every
 *  unquoted/double-quoted `$(...)` and backtick span with a placeholder, the
 *  only place a raw `$(` or backtick may legitimately remain is inside a
 *  single-quoted literal (real shell text, never expanded). Scanning only for
 *  single-quote state and finding either construct outside one means
 *  extraction missed something - an unforeseen construct, not a proven-safe
 *  literal - so for lanes the parse fails and the fallback text scan decides. */
export function hasUnextractedSubstitution(text: string): boolean {
  let inSingleQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inSingleQuote) {
      if (c === "'") inSingleQuote = false;
      continue;
    }
    if (c === "'") {
      inSingleQuote = true;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") return true;
    if (c === "`") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Prefix stripping: env / command / nice / timeout / xargs wrappers and leading
// `VAR=value` assignments (C4 item 5: "strip env, command, nice, timeout, xargs
// prefixes").
// ---------------------------------------------------------------------------

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Wrapper commands to strip to reach the effective command (C4 item 5, extended
// by a course correction from the main thread, 2026-09-27, to also cover
// `time`, `exec`, `sudo`, `doas`, `stdbuf`, `ionice`, `chrt`, `taskset`,
// `unbuffer`, `setpriv`). Each maps to its value-taking flags (a flag whose
// argument is a separate following token, not `--flag=value`).
const VALUE_FLAGS: Record<string, Set<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  xargs: new Set(["-I", "-L", "-n", "-P", "-s", "-a", "-d", "-E"]),
  time: new Set(["-o", "--output", "-f", "--format"]),
  exec: new Set(["-a"]),
  sudo: new Set([
    "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
    "-C", "--close-from", "-r", "--role", "-t", "--type", "-T", "--timeout",
  ]),
  doas: new Set(["-u", "-C"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
  // chrt and taskset take their own positional argument (priority / cpu mask)
  // before the wrapped command, handled by SKIP_POSITIONAL_AFTER_FLAGS below,
  // like timeout's duration; their flags themselves are all no-value in the
  // common "wrap a command" invocation form.
  chrt: new Set(),
  taskset: new Set(),
  unbuffer: new Set(),
  // setpriv's options are practically always self-contained `--flag=value`
  // tokens, so an empty value-flag set is the safe default: treating a
  // no-value setpriv flag as value-taking would wrongly eat the real command.
  setpriv: new Set(),
};

const WRAPPER_COMMANDS = new Set(Object.keys(VALUE_FLAGS));

// timeout's duration, chrt's priority and taskset's cpu mask are each one
// bare positional argument between the flags and the wrapped command.
const SKIP_POSITIONAL_AFTER_FLAGS = new Set(["timeout", "chrt", "taskset"]);

export function basename(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1];
}

function stripOneWrapper(tokens: string[]): string[] | null {
  if (tokens.length === 0) return null;
  if (ASSIGNMENT.test(tokens[0])) return tokens.slice(1);
  const head = basename(tokens[0]);
  if (head === "command") {
    const rest = tokens.slice(1);
    if (rest[0] === "-p") return rest.slice(1);
    return rest;
  }
  if (WRAPPER_COMMANDS.has(head)) {
    const valueFlags = VALUE_FLAGS[head];
    let idx = 1;
    while (idx < tokens.length && tokens[idx].startsWith("-") && tokens[idx] !== "--") {
      const flag = tokens[idx].split("=")[0];
      const takesValue = valueFlags.has(flag) && !tokens[idx].includes("=");
      idx++;
      if (takesValue) idx++;
    }
    if (idx < tokens.length && tokens[idx] === "--") idx++;
    if (SKIP_POSITIONAL_AFTER_FLAGS.has(head)) {
      // Skip the duration/priority/mask argument itself.
      if (idx < tokens.length) idx++;
    }
    return tokens.slice(idx);
  }
  return null;
}

/** Repeatedly strip assignment/env/command/nice/timeout/xargs prefixes to
 *  reach the effective command tokens. */
export function stripWrappers(tokens: string[]): string[] {
  let current = tokens;
  for (let guard = 0; guard < 16; guard++) {
    const next = stripOneWrapper(current);
    if (next === null) return current;
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// `bash -c` / `sh -c` (and zsh/dash/ksh) unwrap, matching the shared
// backlog-guard.py's SHELL_BINARIES set for consistency across guards.
// ---------------------------------------------------------------------------

const SHELL_BINARIES = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

function hasDashC(tokens: string[]): number {
  // Returns the index of the string argument following a -c-ish flag, or -1.
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--") break;
    const sign = t[0];
    // `+o`/`+O` are bash's option-DISABLE form (e.g. `set +o pipefail`),
    // syntactically identical to `-o`/`-O` for scanning purposes (CodeRabbit
    // finding, main-thread course correction, 2026-09-27).
    if (sign !== "-" && sign !== "+") break; // reached a positional argument
    if (sign === "-" && t.startsWith("--")) {
      i += 1; // a long flag (never -c itself, which is always short)
      continue;
    }
    const flags = t.slice(1);
    if (sign === "-" && flags.includes("c")) {
      // `+c` is not a real bash option; only `-c` runs a command string.
      let idx = i + 1;
      if (tokens[idx] === "--") idx++;
      return idx < tokens.length ? idx : -1;
    }
    const lastFlag = flags[flags.length - 1];
    if (lastFlag === "o" || lastFlag === "O") {
      // `-o`/`+o` ("set -o pipefail") and the uppercase `-O`/`+O`
      // (shopt-style), alone or as the last letter of a cluster (`-euo`),
      // take a following value (the option name) that must not be mistaken
      // for a positional argument, which would stop the scan too early.
      i += 2;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** If `tokens` (already wrapper-stripped) is a shell invoked with a -c-ish
 *  flag, return the string argument to recursively parse. Otherwise null. */
function unwrapShellC(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const head = basename(tokens[0]);
  if (!SHELL_BINARIES.has(head)) return null;
  const idx = hasDashC(tokens.slice(1));
  if (idx < 0) return null;
  return tokens.slice(1)[idx] ?? null;
}

// ---------------------------------------------------------------------------
// Shell reserved words: parse what is cheap.
// A segment's leading opener words are stripped so the real command is its
// head (`do git push -f`, `if ! git ...`, `{ git ...`); a segment that starts
// with a closer holds only redirect targets after it (`} > file`, `done <
// <(cmd)`) and is dropped. The command inside a process substitution after a
// closer is extracted separately and still evaluated.
// ---------------------------------------------------------------------------

const RESERVED_OPENERS = new Set(["{", "!", "if", "then", "else", "elif", "do", "while", "until"]);
const RESERVED_CLOSERS = new Set(["}", "fi", "done", "esac"]);

export function stripReservedWords(tokens: string[]): string[] {
  let k = 0;
  while (k < tokens.length && RESERVED_OPENERS.has(tokens[k])) k++;
  if (k < tokens.length && RESERVED_CLOSERS.has(tokens[k])) return [];
  return tokens.slice(k);
}

// ---------------------------------------------------------------------------
// Top-level parser
// ---------------------------------------------------------------------------

export interface ParsedCommand {
  /** Every segment that needs rule-checking: original segments plus the
   *  recursively unwrapped contents of `bash -c`/substitutions and of any
   *  heredoc or here-string a shell reads as its script. */
  segments: string[][];
  hasBackgroundOperator: boolean;
  /** Script texts a heredoc or here-string feeds to an interpreter reading
   *  its script from stdin (`python3 - <<EOF`, `cat <<EOF | node`). Not
   *  blocked as such; evaluateBashCommand gives each the fallback text scan. */
  interpreterScripts: string[];
  /** Every file an output redirection writes to, nested parses included. */
  writeTargets: string[];
}

const MAX_DEPTH = 8;

/** One stdin input attached to a segment: a heredoc body or a here-string. */
interface StdinInput {
  text: string;
  /** Unquoted-delimiter heredoc: the outer shell expands the body. */
  expandable: boolean;
}

/** True when `tokens` (wrapper-stripped) is a shell or shell builtin that
 *  would run its stdin as a script. `rawSegment` is the segment before
 *  wrapper stripping: a wrapper left with no command of its own (`sudo -s`,
 *  `sudo -i`) starts a shell, so it counts as one. */
function runsStdinAsScript(tokens: string[], rawSegment: string[]): boolean {
  if (tokens.length === 0) {
    return rawSegment.length > 0 && WRAPPER_COMMANDS.has(basename(rawSegment[0]));
  }
  const head = basename(tokens[0]);
  return SHELL_BINARIES.has(head) || head === "eval" || head === "source" || head === ".";
}

export function parseCommand(
  command: string,
  role?: Role,
  depth = 0,
  ctx: ParseContext = { heredocs: [] },
): ParsedCommand | null {
  if (depth > MAX_DEPTH) return null;
  const withoutHeredocs = stripHeredocs(command, ctx);
  if (withoutHeredocs === null) return null;
  const extracted = extractSubstitutions(withoutHeredocs);
  if (!extracted) return null;
  // Defense in depth (course correction, main thread, 2026-09-27): lanes fail
  // closed if a raw `$(` or backtick survives extraction anywhere outside a
  // single-quoted literal - that can only mean an unforeseen construct the
  // extractor did not recognise, not a proven-safe pass-through.
  if (role === "lane" && hasUnextractedSubstitution(extracted.text)) return null;
  const tokens = lex(extracted.text);
  if (!tokens) return null;
  const { segments: rawSegments, pipesToNext, hasBackground, writeTargets } = splitSegments(tokens);

  const segments: string[][] = [];
  let hasBackgroundOperator = hasBackground;
  const interpreterScripts: string[] = [];

  const absorb = (nested: ParsedCommand) => {
    segments.push(...nested.segments);
    hasBackgroundOperator = hasBackgroundOperator || nested.hasBackgroundOperator;
    interpreterScripts.push(...nested.interpreterScripts);
    writeTargets.push(...nested.writeTargets);
  };

  // Pull heredoc placeholders and here-string markers out of every segment,
  // leaving the command's real words and recording what it reads on stdin.
  const cleaned: string[][] = [];
  const stdinInputs: StdinInput[][] = [];
  for (const segment of rawSegments) {
    const words: string[] = [];
    const inputs: StdinInput[] = [];
    for (let k = 0; k < segment.length; k++) {
      const tok = segment[k];
      const m = HEREDOC_PLACEHOLDER.exec(tok);
      if (m) {
        const heredoc = ctx.heredocs[Number(m[1])];
        if (!heredoc) return null;
        inputs.push({ text: heredoc.body, expandable: !heredoc.quoted });
        continue;
      }
      if (tok === HERESTRING_MARKER) {
        const word = segment[k + 1];
        if (word === undefined) return null;
        inputs.push({ text: word, expandable: false });
        k++;
        continue;
      }
      words.push(tok);
    }
    cleaned.push(stripReservedWords(words));
    stdinInputs.push(inputs);
  }

  for (let s = 0; s < cleaned.length; s++) {
    // Subshells and brace groups: `(` and `)`
    // are segment separators in the lexer and `{`/`}` are reserved words
    // stripped above, so the commands inside are ordinary segments here.
    const segment = cleaned[s];
    if (segment.length) segments.push(segment);
    const stripped = stripWrappers(segment);
    const inner = unwrapShellC(stripped);
    if (inner !== null) {
      const nested = parseCommand(inner, role, depth + 1, ctx);
      if (!nested) return null;
      absorb(nested);
    }
    if (stripped.length > 1 && basename(stripped[0]) === "eval") {
      // `eval` joins its arguments with spaces and runs the result as a
      // script: evaluate it with the same rules.
      const nested = parseCommand(stripped.slice(1).join(" "), role, depth + 1, ctx);
      if (!nested) return null;
      absorb(nested);
    }

    for (const input of stdinInputs[s]) {
      // An unquoted body's substitutions run in the outer shell whatever
      // receives the body, so they are always evaluated.
      if (input.expandable) {
        const subs = extractBodySubstitutions(input.text);
        if (!subs) return null;
        for (const sub of subs) {
          const nested = parseCommand(sub, role, depth + 1, ctx);
          if (!nested) return null;
          absorb(nested);
        }
      }
      // The body reaches the receiving command and, through `|`, every later
      // command in the same pipeline (`cat <<EOF | sh`). A shell among them
      // runs it as a script; an interpreter reading stdin runs it as code.
      // For any other command (cat, tee, printf, jq, apply_patch...) it is
      // inert data.
      let runAsScript = false;
      const script = input.expandable ? unescapeHeredocBody(input.text) : input.text;
      for (let r = s; r < cleaned.length; r++) {
        const receiver = stripWrappers(cleaned[r]);
        if (runsStdinAsScript(receiver, cleaned[r])) runAsScript = true;
        if (readsScriptFromStdin(receiver, true)) interpreterScripts.push(script);
        if (!pipesToNext[r]) break;
      }
      if (runAsScript) {
        const nested = parseCommand(script, role, depth + 1, ctx);
        if (!nested) return null;
        absorb(nested);
      }
    }
  }

  for (const innerCommand of extracted.inner) {
    const nested = parseCommand(innerCommand, role, depth + 1, ctx);
    if (!nested) return null;
    absorb(nested);
  }

  return { segments, hasBackgroundOperator, interpreterScripts, writeTargets };
}

// ---------------------------------------------------------------------------
// git argument resolution: skip global options (`-c`, `-C`, `--git-dir`,
// `--work-tree`, `--namespace`) to reach the subcommand and its own args,
// matching staging-guard.py's git_arguments() and the plan's "treat
// `git -c alias.*` as its target command" (a `-c` override is a global option
// to skip past, not the subcommand itself).
// ---------------------------------------------------------------------------

const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace"]);

export function gitArguments(tokens: string[]): string[] {
  // tokens[0] is expected to be "git" (basename-resolved by the caller).
  let rest = tokens.slice(1);
  while (rest.length && rest[0].startsWith("-")) {
    const opt = rest[0];
    const bareOpt = opt.split("=")[0];
    rest = rest.slice(1);
    if (GIT_GLOBAL_VALUE_OPTIONS.has(bareOpt) && !opt.includes("=")) {
      rest = rest.slice(1);
    }
  }
  return rest;
}

export interface ResolvedGitCommand {
  /** The effective subcommand and its arguments, after resolving a
   *  `-c alias.<name>=<value>` in the subcommand position (plan C4 item 5:
   *  "treat `git -c alias.<name>=<cmd> <name> ...` as `git <cmd> ...`"). One
   *  level of alias resolution only, matching real git's own non-recursive
   *  expansion (recorded here, not covered by the plan). */
  args: string[];
  /** Set instead of `args` when the resolved alias is a `!`-shell alias: the
   *  shell command text to evaluate in place of the git subcommand, with the
   *  call's own trailing arguments appended, each individually shell-quoted
   *  so an argument containing shell metacharacters (`;`, `&&`, ...) stays
   *  one inert string argument rather than being re-split into a second
   *  command (CodeRabbit finding, main-thread course correction,
   *  2026-09-27). */
  shellCommand?: string;
  /** Set when the resolved alias's own body could not itself be lexed (e.g.
   *  an unterminated quote): the alias must not be silently treated as an
   *  inert literal subcommand string, since that would let an
   *  unparseable-but-dangerous alias body straight past every check with no
   *  warning (CodeRabbit finding, main-thread course correction,
   *  2026-09-27). Same posture as any other unparseable input: the fallback
   *  text scan, over `aliasText`. */
  unparseable?: boolean;
  /** With `unparseable`: `git <alias body> <trailing args>` for the scan. */
  aliasText?: string;
}

/** Shell-quotes one literal argument (wraps in single quotes, escaping any
 *  embedded single quote as `'\''`) so it survives being joined back into a
 *  command string and re-lexed as exactly one word. */
function quoteForShell(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Like `gitArguments`, but also collects every `-c alias.<name>=<value>`
 *  seen among the global options and, when the resolved subcommand position
 *  names one of those aliases, expands it: either into the alias's own git
 *  subcommand text (plus the call's trailing args), or, for a `!`-prefixed
 *  alias, into a shell command to evaluate. */
export function resolveGitArguments(tokens: string[]): ResolvedGitCommand {
  // tokens[0] is expected to be "git" (basename-resolved by the caller).
  let rest = tokens.slice(1);
  const aliases = new Map<string, string>();
  while (rest.length && rest[0].startsWith("-")) {
    const opt = rest[0];
    const eq = opt.indexOf("=");
    const bareOpt = eq >= 0 ? opt.slice(0, eq) : opt;
    let value = eq >= 0 ? opt.slice(eq + 1) : undefined;
    rest = rest.slice(1);
    if (bareOpt === "-c") {
      if (value === undefined) {
        value = rest[0];
        rest = rest.slice(1);
      }
      const m = value !== undefined ? /^alias\.([^=\s]+)=([\s\S]*)$/.exec(value) : null;
      // git's own config-key lookup is case-insensitive for the variable
      // name (verified live: `git -c alias.wtf=status WTF` and `git -c
      // alias.WTF=status wtf` both run `status`), so the name is normalized
      // to lowercase on both storage and lookup (CodeRabbit finding,
      // main-thread course correction, 2026-09-27).
      if (m) aliases.set(m[1].toLowerCase(), m[2]);
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTIONS.has(bareOpt) && value === undefined) {
      rest = rest.slice(1);
    }
  }

  const sub = rest[0];
  const aliasValue = sub !== undefined ? aliases.get(sub.toLowerCase()) : undefined;
  if (aliasValue !== undefined) {
    const trailing = rest.slice(1);
    if (aliasValue.startsWith("!")) {
      const shellPart = aliasValue.slice(1).trim();
      const quotedTrailing = trailing.map(quoteForShell);
      const shellCommand = [shellPart, ...quotedTrailing].filter((part) => part.length > 0).join(" ");
      return { args: rest, shellCommand };
    }
    const aliasTokens = lex(aliasValue);
    if (aliasTokens === null) {
      return { args: rest, unparseable: true, aliasText: ["git", aliasValue, ...trailing].join(" ") };
    }
    const flatAliasTokens = aliasTokens.filter((t): t is string => typeof t === "string");
    return { args: [...flatAliasTokens, ...trailing] };
  }
  return { args: rest };
}

// ---------------------------------------------------------------------------
// Every-role git rules (C4 item 2)
// ---------------------------------------------------------------------------

// A short-flag cluster is a single `-` followed by only letters (`-uf`,
// `-Av`): never a long `--flag` and never a flag's own value (a value token
// is a separate array element, so this regex only ever matches a flag
// position, not an argument like `-m "-a"`'s "-a").
const SHORT_FLAG_CLUSTER = /^-[a-zA-Z]+$/;

function isForcePush(pushArgs: string[]): boolean {
  // After `--`, a remaining token is a plain refspec, never an option
  // (verified live: `git push origin -- -f` fails with "src refspec -f does
  // not match any", never force-pushes) - CodeRabbit finding. But a
  // refspec's OWN `+`/`:` syntax keeps forcing regardless of `--` (verified
  // live: `git push origin -- +feature:feature` still force-updates), so
  // only the option-shaped checks stop at `--`, never the refspec-shaped ones.
  let optionsEnded = false;
  for (const tok of pushArgs) {
    if (tok === "--") {
      optionsEnded = true;
      continue;
    }
    if (tok.startsWith("+")) return true; // +refspec forces the update
    if (tok.startsWith(":") && tok.length > 1) return true; // :branch deletes the remote ref
    if (optionsEnded) continue;
    if (tok === "--force") return true;
    if (tok === "--force-with-lease" || tok.startsWith("--force-with-lease=")) return true;
    if (tok === "--mirror") return true;
    if (tok === "--delete") return true;
    // Combined short-flag clusters (`-uf`, `-fu`, `-d`, ...): `f` is
    // `--force` and `d` is `--delete` in any position within the cluster.
    if (SHORT_FLAG_CLUSTER.test(tok) && (tok.includes("f") || tok.includes("d"))) return true;
  }
  return false;
}

function isBulkAdd(addArgs: string[]): boolean {
  return addArgs.some(
    (tok) => tok === "--all" || tok === "." || (SHORT_FLAG_CLUSTER.test(tok) && tok.includes("A")),
  );
}

// git commit flags that take a following value token, so that value is never
// mistaken for a flag of its own (fixes the false positive on
// `git commit -m "-a" -- f`, where "-a" is -m's argument, not a real flag).
const COMMIT_VALUE_FLAGS = new Set([
  "-m", "--message",
  "-F", "--file",
  "-c", "-C", "--reuse-message", "--reedit-message",
  "--fixup", "--squash",
  "--author", "--date",
  "--template",
]);

function isCommitDashA(commitArgs: string[]): boolean {
  for (let i = 0; i < commitArgs.length; i++) {
    const tok = commitArgs[i];
    const bareTok = tok.split("=")[0];
    if (COMMIT_VALUE_FLAGS.has(bareTok) && !tok.includes("=")) {
      i++; // skip the value token: it is an argument, never a flag.
      continue;
    }
    if (tok === "--all" || (SHORT_FLAG_CLUSTER.test(tok) && tok.includes("a"))) return true;
  }
  return false;
}

/** The three every-role git subcommand checks (force push, bulk add, commit
 *  -a), applied to one resolved `gitArgs` reading (subcommand + its own
 *  args). Returns the block Decision for the first violation found, or null
 *  if this reading raises none. Shared so evaluateBashCommand can run it
 *  against both the unexpanded and the alias-expanded reading of a `git`
 *  invocation (course correction, main thread, 2026-09-27: a `-c
 *  alias.<name>=<value>` whose <name> shadows a real built-in is ignored by
 *  real git, so relying on the expanded reading alone would miss it). */
function checkGitPushAddCommit(gitArgs: string[], pushGranted = true): Decision | null {
  const sub = gitArgs[0];
  if (sub === "push" && isForcePush(gitArgs.slice(1))) {
    return block("loop-guard: force-push forms are blocked for every role (SEAMS.md push grant).");
  }
  if (sub === "push" && !pushGranted) {
    return block("loop-guard: git push requires a push-granted lane identity (SEAMS.md push grant).");
  }
  if (sub === "add" && isBulkAdd(gitArgs.slice(1))) {
    return block("loop-guard: `git add -A`, `.` or `--all` is blocked; add explicit pathspecs.");
  }
  if (sub === "commit" && isCommitDashA(gitArgs.slice(1))) {
    return block("loop-guard: `git commit -a` is blocked; commit explicit pathspecs instead.");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lane-only rules (C4 item 3)
// ---------------------------------------------------------------------------

// `python`, `python3`, or a versioned interpreter (`python3.12`, `python2.7`).
const PYTHON_INTERPRETER = /^python[0-9]*(\.[0-9]+)?$/;

// Interpreter flags whose value is the following token, so that value is never
// taken for the script-file positional. Honest-fence coverage of the common
// forms, not every flag each runtime has.
const INTERPRETER_VALUE_FLAGS: Record<string, Set<string>> = {
  python: new Set(["-W", "-X", "-Q"]),
  node: new Set([
    "-r", "--require", "--import", "--loader", "--experimental-loader", "--input-type",
    "-C", "--conditions", "--env-file", "--title",
  ]),
  ruby: new Set(["-I", "-r", "-C", "-E"]),
  perl: new Set(),
  deno: new Set(["-c", "--config", "--import-map", "--location", "--cert", "--lock", "--env-file"]),
  bun: new Set(),
};

/** True when `tokens` (wrapper-stripped) is an interpreter that takes its
 *  script from stdin: an explicit `-` script argument (`python3 -`, `node
 *  --input-type=module -`, `deno run -`, `bun -`), or, when
 *  `implicitStdin` is set because a heredoc or here-string feeds it, no
 *  script argument at all (`python3 <<EOF`). A module run (`python3 -m
 *  json.tool`) or a script file reads stdin as data, not code. */
function readsScriptFromStdin(tokens: string[], implicitStdin: boolean): boolean {
  if (tokens.length === 0) return false;
  const head = basename(tokens[0]);
  let family: string;
  let args = tokens.slice(1);
  if (PYTHON_INTERPRETER.test(head)) family = "python";
  else if (head === "node" || head === "nodejs") family = "node";
  else if (head === "ruby" || head === "perl") family = head;
  else if (head === "deno") {
    if (args[0] !== "run") return false;
    family = "deno";
    args = args.slice(1);
  } else if (head === "bun") {
    family = "bun";
    if (args[0] === "run") args = args.slice(1);
    // `bun` or `bun run` with no script prints help or lists package scripts.
    implicitStdin = false;
  } else return false;

  const valueFlags = INTERPRETER_VALUE_FLAGS[family];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "-") return true;
    if (tok === "--") return args[i + 1] === "-" || (args[i + 1] === undefined && implicitStdin);
    if (!tok.startsWith("-")) return false; // a script file
    if (family === "python" && (tok === "-m" || (SHORT_FLAG_CLUSTER.test(tok) && tok.endsWith("m")))) return false;
    if (valueFlags.has(tok)) i++;
  }
  return implicitStdin;
}

/** Interpreters whose inline code (`-c`, `-e`, `--eval`, `-p`, or any other
 *  argument) gets the fallback text scan. Not blocked as such (owner
 *  decision, 2026-09-28). */
function isInterpreterHead(head: string): boolean {
  return PYTHON_INTERPRETER.test(head) || ["node", "nodejs", "perl", "ruby", "deno", "bun"].includes(head);
}

export type ForbiddenCategory = "release" | "workflow" | "api" | "secret" | "credential";

export interface ForbiddenCommand {
  label: string;
  category: ForbiddenCategory;
}

/** `gh api` with a mutating method or a request body (`-X/--method POST|PUT|PATCH|DELETE` in any
 *  spelling, `-f/-F/--field/--raw-field`, `--input`). */
function isMutatingGhApi(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    let method: string | undefined;
    if (t === "-X" || t === "--method") method = rest[i + 1];
    else if (t.startsWith("--method=")) method = t.slice("--method=".length);
    else if (/^-X./.test(t)) method = t.slice(2);
    if (method !== undefined && /^(POST|PUT|PATCH|DELETE)$/i.test(method)) return true;
    if (["-f", "-F", "--field", "--raw-field", "--input"].includes(t)) return true;
    if (/^-[fF]./.test(t) || /^--(field|raw-field|input)=/.test(t)) return true;
  }
  return false;
}

const AWS_SECRET_WRITES = new Set(["put-secret-value", "create-secret", "update-secret"]);
const AWS_IAM_CREDENTIALS = new Set([
  "create-access-key",
  "create-login-profile",
  "update-login-profile",
  "create-service-specific-credential",
  "reset-service-specific-credential",
]);

/** The aws `<service> <operation>` pair, found past any global options (`aws --region x iam ...`). */
function awsServiceCall(rest: string[], service: string, operations: ReadonlySet<string>): string | undefined {
  const at = rest.indexOf(service);
  if (at < 0 || !operations.has(rest[at + 1] ?? "")) return undefined;
  return rest[at + 1];
}

/** Releases, workflow dispatch, mutating `gh api`, secret-store writes and credential creation,
 *  blocked for every lane unless an ops grant re-allows the exact command (opsPermits).
 *
 * Design decision: lanes may deploy, change clusters and cloud resources, and ssh.
 * - release: `gh release create|edit|delete`.
 * - workflow: `gh workflow run`.
 * - api: mutating `gh api`.
 * - secret: `gh secret set`, `vault write` / `vault kv put`, `bao write` / `bao kv put` /
 *   `bao secret put`, `op item create|edit`, `aws secretsmanager put-secret-value|create-secret|
 *   update-secret`.
 * - credential: `vault|bao token create`, `aws iam create-access-key|create-login-profile|
 *   update-login-profile|create-service-specific-credential|reset-service-specific-credential`,
 *   `gcloud iam service-accounts keys create`, `gh ssh-key|gpg-key add`,
 *   `az ad sp|app credential reset`, `az ad sp create-for-rbac`, `op service-account create`,
 *   `op connect token create`.
 */
export function classifyLaneForbidden(tokens: string[]): ForbiddenCommand | undefined {
  if (tokens.length === 0) return undefined;
  const head = basename(tokens[0]);
  const rest = tokens.slice(1);
  const found = (label: string, category: ForbiddenCategory): ForbiddenCommand => ({ label, category });
  if (head === "gh") {
    if (rest[0] === "release" && ["create", "edit", "delete"].includes(rest[1])) return found(`gh release ${rest[1]}`, "release");
    if (rest[0] === "workflow" && rest[1] === "run") return found("gh workflow run", "workflow");
    if (rest[0] === "secret" && rest[1] === "set") return found("gh secret set", "secret");
    if (rest[0] === "api" && isMutatingGhApi(rest.slice(1))) return found("gh api (mutating)", "api");
    if ((rest[0] === "ssh-key" || rest[0] === "gpg-key") && rest[1] === "add") return found(`gh ${rest[0]} add`, "credential");
  }
  if (head === "vault" || head === "bao") {
    if (rest[0] === "write" || (rest[0] === "kv" && rest[1] === "put")) return found(`${head} write`, "secret");
    if (head === "bao" && rest[0] === "secret" && rest[1] === "put") return found("bao write", "secret");
    if (rest[0] === "token" && rest[1] === "create") return found(`${head} token create`, "credential");
  }
  if (head === "op") {
    if (rest[0] === "item" && ["create", "edit"].includes(rest[1])) return found("op item write", "secret");
    if (rest[0] === "service-account" && rest[1] === "create") return found("op service-account create", "credential");
    if (rest[0] === "connect" && rest[1] === "token" && rest[2] === "create") return found("op connect token create", "credential");
  }
  if (head === "aws") {
    if (awsServiceCall(rest, "secretsmanager", AWS_SECRET_WRITES)) return found("aws secretsmanager write", "secret");
    const iam = awsServiceCall(rest, "iam", AWS_IAM_CREDENTIALS);
    if (iam) return found(`aws iam ${iam}`, "credential");
  }
  if (head === "gcloud") {
    const at = rest.indexOf("iam");
    if (at >= 0 && rest[at + 1] === "service-accounts" && rest[at + 2] === "keys" && rest[at + 3] === "create")
      return found("gcloud iam service-accounts keys create", "credential");
  }
  if (head === "az" && rest[0] === "ad") {
    if ((rest[1] === "sp" || rest[1] === "app") && rest[2] === "credential" && rest[3] === "reset")
      return found(`az ad ${rest[1]} credential reset`, "credential");
    if (rest[1] === "sp" && rest[2] === "create-for-rbac") return found("az ad sp create-for-rbac", "credential");
  }
  return undefined;
}

function laneForbiddenCommand(tokens: string[]): string | undefined {
  return classifyLaneForbidden(tokens)?.label;
}

const LANE_FORBIDDEN_REASON =
  "is a release, workflow dispatch, mutating gh api, secret-store write or credential creation, blocked for lanes";

// ---------------------------------------------------------------------------
// Secret-store write targets. An ops grant lets a secret write through only when the target
// extracted here equals a member of `entry.secret_paths` exactly. Null means the target cannot be
// read unambiguously, which refuses the write.
//
// - `vault|bao write [flags] <path> ...`: `<path>`.
// - `vault|bao kv put [flags] <path> ...`, `bao secret put ...`: `<path>`, or `<mount>/<path>` with
//   `-mount=<mount>`.
//   Flags before the path must be `-name=value` or one of -force, -f, -non-interactive,
//   -tls-skip-verify, -no-color; a later token starting with `-` (other than a bare `-`) refuses.
// - `gh secret set <NAME> [flags]`: `<NAME>`. Exactly one positional; `-f/--env-file` (many names)
//   or an unknown flag refuses. Repository, org and environment scope are pinned by the allow
//   pattern, not by the target.
// - `op item create`: `<vault>/<title>` from `--vault` and `--title`, both required.
// - `op item edit <item>`: `<vault>/<item>`, `--vault` required.
// - `aws secretsmanager put-secret-value|update-secret`: the `--secret-id` value;
//   `create-secret`: the `--name` value. `--cli-input-json` / `--cli-input-yaml` refuses.
// A flag given twice refuses.
// ---------------------------------------------------------------------------

const VAULT_BOOL_FLAGS = new Set(["force", "f", "non-interactive", "tls-skip-verify", "no-color"]);

function vaultPathTarget(args: string[], mountAware: boolean): string | null {
  const flags = new Map<string, string>();
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i];
    if (t === "--") {
      i++;
      break;
    }
    if (!t.startsWith("-") || t === "-") break;
    const body = t.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    if (eq < 0 && !VAULT_BOOL_FLAGS.has(name)) return null;
    if (flags.has(name)) return null;
    flags.set(name, eq >= 0 ? body.slice(eq + 1) : "true");
  }
  const path = args[i];
  if (path === undefined || path === "" || path === "-" || path.startsWith("-")) return null;
  if (args.slice(i + 1).some((t) => t.startsWith("-") && t !== "-")) return null;
  const mount = flags.get("mount");
  if (mount !== undefined && !mountAware) return null;
  if (mount !== undefined) return `${mount.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return path;
}

interface FlagSpec {
  value: ReadonlySet<string>;
  bool: ReadonlySet<string>;
}

/** pflag-style parse: `--name value`, `--name=value`, `-x value`, `-xvalue`. Null on an unknown flag
 *  or a repeated value flag. */
function parsePflags(args: string[], spec: FlagSpec): { flags: Map<string, string>; positionals: string[] } | null {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!t.startsWith("-") || t === "-") {
      positionals.push(t);
      continue;
    }
    let name: string;
    let value: string | undefined;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      name = eq >= 0 ? t.slice(0, eq) : t;
      value = eq >= 0 ? t.slice(eq + 1) : undefined;
    } else {
      name = t.slice(0, 2);
      value = t.length > 2 ? t.slice(2).replace(/^=/, "") : undefined;
    }
    if (spec.bool.has(name) && value === undefined) {
      flags.set(name, "true");
      continue;
    }
    if (!spec.value.has(name)) return null;
    if (value === undefined) {
      value = args[++i];
      if (value === undefined) return null;
    }
    if (flags.has(name)) return null;
    flags.set(name, value);
  }
  return { flags, positionals };
}

const GH_SECRET_SET_FLAGS: FlagSpec = {
  value: new Set(["-b", "--body", "-e", "--env", "-f", "--env-file", "-o", "--org", "-R", "--repo", "-a", "--app", "-v", "--visibility", "-r", "--repos"]),
  bool: new Set(["-u", "--user", "--no-store", "--no-repos-selected"]),
};

const OP_ITEM_FLAGS: FlagSpec = {
  value: new Set([
    "--vault", "--title", "--category", "--url", "--tags", "--template", "--account", "--session", "--config",
    "--encoding", "--format", "--generate-password", "--ssh-generate-key",
  ]),
  bool: new Set(["--dry-run", "--favorite", "--debug", "--no-color", "--iso-timestamps", "--cache", "--reveal"]),
};

function awsOptionValue(args: string[], option: string): string | null {
  let value: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    let v: string | undefined;
    if (t === option) v = args[i + 1];
    else if (t.startsWith(`${option}=`)) v = t.slice(option.length + 1);
    if (v === undefined) continue;
    if (value !== null) return null;
    value = v;
  }
  return value;
}

export function secretWriteTarget(tokens: string[]): string | null {
  const head = basename(tokens[0] ?? "");
  const rest = tokens.slice(1);
  if (head === "vault" || head === "bao") {
    if (rest[0] === "write") return vaultPathTarget(rest.slice(1), false);
    if ((rest[0] === "kv" && rest[1] === "put") || (head === "bao" && rest[0] === "secret" && rest[1] === "put"))
      return vaultPathTarget(rest.slice(2), true);
    return null;
  }
  if (head === "gh" && rest[0] === "secret" && rest[1] === "set") {
    const parsed = parsePflags(rest.slice(2), GH_SECRET_SET_FLAGS);
    if (!parsed || parsed.positionals.length !== 1) return null;
    if (parsed.flags.has("-f") || parsed.flags.has("--env-file")) return null;
    return parsed.positionals[0] || null;
  }
  if (head === "op" && rest[0] === "item" && (rest[1] === "create" || rest[1] === "edit")) {
    const parsed = parsePflags(rest.slice(2), OP_ITEM_FLAGS);
    if (!parsed) return null;
    const vault = parsed.flags.get("--vault");
    if (!vault) return null;
    if (rest[1] === "create") {
      const title = parsed.flags.get("--title");
      return title ? `${vault}/${title}` : null;
    }
    const item = parsed.positionals[0];
    return item && !item.includes("=") ? `${vault}/${item}` : null;
  }
  if (head === "aws") {
    const at = rest.indexOf("secretsmanager");
    const operation = rest[at + 1];
    if (at < 0 || !AWS_SECRET_WRITES.has(operation ?? "")) return null;
    const args = rest.slice(at + 2);
    if (args.some((t) => /^--cli-input-(json|yaml)(=|$)/.test(t))) return null;
    return awsOptionValue(args, operation === "create-secret" ? "--name" : "--secret-id");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ops grants (lane side): a lane-forbidden command passes for agent `ops` only when the whole
// segment fully matches one of the entry's anchored `allow` patterns, a secret write targets a
// member of `secret_paths` exactly, and a credential creation is under kind `credential-create`.
// ---------------------------------------------------------------------------

export interface LaneContext {
  /** The ops entry bound to this lane by the root (agent `ops` only). */
  ops?: OpsEntry;
  /** The lane's working directory, for resolving relative write targets. */
  cwd?: string;
}

/** One segment as the allow patterns see it: words joined by single spaces, any word holding
 *  whitespace or shell syntax single-quoted. */
export function opsSubject(segment: string[]): string {
  return segment.map((w) => (/^[A-Za-z0-9_@%+=:,./^-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
}

function fullMatch(pattern: string, subject: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(subject);
  } catch {
    return false;
  }
}

/** Null when the ops entry permits this forbidden segment, else the reason it does not. */
function opsRefusal(segment: string[], stripped: string[], forbidden: ForbiddenCommand, entry: OpsEntry): string | null {
  const subject = opsSubject(segment);
  const surface = entry.surface;
  if (!entry.allow.some((pattern) => pattern.startsWith("^") && fullMatch(pattern, subject))) {
    return `'${forbidden.label}' does not fully match any allow pattern of ops surface '${surface}' (matched text: ${subject}).`;
  }
  if (forbidden.category === "credential" && entry.kind !== "credential-create") {
    return `'${forbidden.label}' creates a credential; ops surface '${surface}' is kind '${entry.kind}', not credential-create.`;
  }
  if (forbidden.category === "secret") {
    const target = secretWriteTarget(stripped);
    if (target === null) return `the target of '${forbidden.label}' cannot be read unambiguously, so ops surface '${surface}' cannot grant it.`;
    if (!(entry.secret_paths ?? []).includes(target)) {
      return `'${forbidden.label}' writes '${target}', which is not in secret_paths of ops surface '${surface}'.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Loop control files. Every lane is refused writes into `codex/ops-*`, `codex/state-*` and
// `codex/goal-*` (and the `codex` directory itself for removal-shaped commands). Edit and write
// tool paths are checked exactly (lane.ts); for bash this is best effort: redirection targets and
// the path arguments of common file-writing commands.
// ---------------------------------------------------------------------------

const LOOP_CONTROL_FILE = /(?:^|\/)codex\/(?:ops|state|goal)-[^/]*$/i;
const LOOP_CONTROL_DIR = /(?:^|\/)codex$/i;
const LOOP_CONTROL_SAMPLES = ["ops-c-loop1.json", "state-c-loop1.jsonl", "goal-c-loop1.md"];

function normalisePosix(path: string, cwd?: string): string {
  let p = path;
  if (cwd && !p.startsWith("/") && !p.startsWith("~") && !p.startsWith("$")) p = `${cwd.replace(/\/+$/, "")}/${p}`;
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (p.startsWith("/") ? "/" : "") + parts.join("/");
}

function globToRegExp(glob: string): RegExp | null {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) return null;
      out += `[${glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      i = end;
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${out}$`, "i");
  } catch {
    return null;
  }
}

/** True when `path` names a loop control file, or a glob in a `codex` directory that could. */
export function isLoopControlPath(path: string, cwd?: string): boolean {
  const p = normalisePosix(path.replace(/^file:\/\//, "").replace(/^@/, ""), cwd);
  if (LOOP_CONTROL_FILE.test(p)) return true;
  const slash = p.lastIndexOf("/");
  const dir = slash >= 0 ? p.slice(0, slash) : "";
  const name = p.slice(slash + 1);
  if (/[*?[]/.test(name) && (LOOP_CONTROL_DIR.test(dir) || (dir === "" && LOOP_CONTROL_DIR.test(cwd ?? "")))) {
    const re = globToRegExp(name);
    return re === null || LOOP_CONTROL_SAMPLES.some((s) => re.test(s));
  }
  return false;
}

const WRITE_ALL_ARGS = new Set(["tee", "touch", "truncate", "rm", "unlink", "shred", "mv", "cp", "ln", "install", "rsync", "rmdir"]);
const REMOVES_DIRS = new Set(["rm", "mv", "rmdir", "rsync"]);

/** The loop control path a file-writing command touches, if any. */
function loopControlWrite(stripped: string[], cwd?: string): string | undefined {
  if (stripped.length === 0) return undefined;
  const head = basename(stripped[0]);
  const args = stripped.slice(1);
  let candidates: string[] = [];
  if (WRITE_ALL_ARGS.has(head)) candidates = args.map((a) => a.replace(/^--?[A-Za-z-]+=/, ""));
  else if (head === "dd") candidates = args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
  else if (head === "sed" || head === "perl" || head === "ruby") {
    const inPlace = args.some((a) => a.startsWith("--in-place") || (/^-[A-Za-z]/.test(a) && !a.startsWith("--") && a.slice(1).includes("i")));
    if (inPlace) candidates = args;
  } else if (head === "loop-state" && args[0] === "append") candidates = args.slice(1);
  for (const c of candidates) {
    if (isLoopControlPath(c, cwd)) return c;
    if (REMOVES_DIRS.has(head) && LOOP_CONTROL_DIR.test(normalisePosix(c, cwd))) return c;
  }
  return undefined;
}

function loopControlReason(path: string): string {
  return `loop-guard: lanes may not write '${path}': codex/ops-*, codex/state-* and codex/goal-* belong to the root.`;
}

// ---------------------------------------------------------------------------
// Public: evaluateBashCommand
// ---------------------------------------------------------------------------

const MAX_GIT_ALIAS_DEPTH = 4;

// ---------------------------------------------------------------------------
// Fallback text scan. Used for input the parser
// cannot read, for a non-shell interpreter's inline code and stdin script, for
// an unlexable git alias body and for a too-deep alias chain. It tokenises
// loosely and blocks only when a dangerous pattern for the role literally
// appears; otherwise it allows silently.
//
// Loose tokenising: backslashes and quote characters are deleted (so
// `'git','push'` and `"git push -f"` read as plain words), the text is cut
// into segments at `; & | newline ( ) { }` and backticks, and each segment is
// split into words at whitespace, `[ ] , < >`.
//
// Patterns:
//   every role - `nohup`/`setsid`/`disown` as any word; a trailing or
//     command-terminating `&` (followed by end, newline, `;`, `)`, `}` or a
//     backtick; never `&&`, `>&`, `&>`, `|&`); a word that is, or ends in
//     `=git`/`!git`, `git` followed by global options and `push` with a force
//     form, `add` with -A/./--all, or `commit` with -a/--all (the same
//     checks as the precise path, including `-c alias.` expansion).
//   lanes also - laneForbiddenCommand at each segment's command position
//     (after reserved words and wrappers, and after a shell's `-c` or
//     `eval`), so a lane-only command counts only as a command word, never as data.
// ---------------------------------------------------------------------------

const FALLBACK_SEGMENT_BREAK = /[;&|\n(){}`]+/;
const FALLBACK_WORD_BREAK = /[\s[\],<>]+/;
const FALLBACK_BACKGROUND = /(?:^|[^&|<>])&(?![&>])[ \t\r]*(?:$|[\n;)}`])/;
const DETACH_WORDS = new Set(["nohup", "setsid", "disown"]);
const MAX_FALLBACK_DEPTH = 4;

function fallbackReason(what: string): string {
  return `loop-guard (fallback scan): ${what}`;
}

function looseSegments(clean: string): string[][] {
  return clean
    .split(FALLBACK_SEGMENT_BREAK)
    .map((seg) => seg.split(FALLBACK_WORD_BREAK).filter((w) => w.length > 0))
    .filter((seg) => seg.length > 0);
}

/** The lane rules at one loose segment's command position(s). */
function fallbackLaneCheck(segment: string[]): string | undefined {
  let words = stripWrappers(stripReservedWords(segment));
  for (let guard = 0; guard < 8 && words.length; guard++) {
    const forbidden = laneForbiddenCommand(words);
    if (forbidden) return forbidden;
    const head = basename(words[0]);
    if (head === "eval") {
      words = stripWrappers(words.slice(1));
      continue;
    }
    if (SHELL_BINARIES.has(head)) {
      const idx = hasDashC(words.slice(1));
      if (idx < 0) return undefined;
      // Quotes are gone, so the script string is every word from here on.
      words = stripWrappers(stripReservedWords(words.slice(1 + idx)));
      continue;
    }
    return undefined;
  }
  return undefined;
}

const FALLBACK_REDIRECT = />{1,2}\|?[ \t]*([^\s;&|()<>]+)/g;

export function fallbackScan(text: string, role: Role, depth = 0, pushGranted = true, lane: LaneContext = {}): Decision {
  const clean = text.replace(/[\\'"]/g, "");
  if (FALLBACK_BACKGROUND.test(clean)) {
    return block(
      fallbackReason(
        "a command-terminating `&` detaches a process outside loop-wait; use watch_start for long-running processes instead.",
      ),
    );
  }
  for (const segment of looseSegments(clean)) {
    for (let i = 0; i < segment.length; i++) {
      const word = segment[i];
      const bare = basename(word.replace(/^.*[=!]/, ""));
      if (DETACH_WORDS.has(basename(word))) {
        return block(fallbackReason(`'${basename(word)}' detaches a process outside loop-wait; use watch_start instead.`));
      }
      if (bare !== "git") continue;
      const tokens = ["git", ...segment.slice(i + 1)];
      const literal = checkGitPushAddCommit(gitArguments(tokens), pushGranted);
      if (literal) return block(fallbackReason(literal.reason ?? ""));
      const resolved = resolveGitArguments(tokens);
      if (resolved.shellCommand !== undefined && depth < MAX_FALLBACK_DEPTH) {
        const nested = fallbackScan(resolved.shellCommand, role, depth + 1, pushGranted, lane);
        if (nested.block) return nested;
      } else if (resolved.aliasText !== undefined && depth < MAX_FALLBACK_DEPTH) {
        const nested = fallbackScan(resolved.aliasText, role, depth + 1, pushGranted, lane);
        if (nested.block) return nested;
      } else {
        const expanded = checkGitPushAddCommit(resolved.args, pushGranted);
        if (expanded) return block(fallbackReason(expanded.reason ?? ""));
      }
    }
    if (role === "lane") {
      const forbidden = fallbackLaneCheck(segment);
      if (forbidden) {
        // An ops grant never applies here: input the parser cannot read stays refused.
        return block(fallbackReason(`'${forbidden}' ${LANE_FORBIDDEN_REASON}.`));
      }
      const control = loopControlWrite(stripWrappers(stripReservedWords(segment)), lane.cwd);
      if (control) return block(fallbackReason(loopControlReason(control)));
    }
  }
  if (role === "lane") {
    for (const m of clean.matchAll(FALLBACK_REDIRECT)) {
      if (isLoopControlPath(m[1], lane.cwd)) return block(fallbackReason(loopControlReason(m[1])));
    }
  }
  return allow();
}

// ---------------------------------------------------------------------------
// Public: evaluateBashCommand
// ---------------------------------------------------------------------------

export function evaluateBashCommand(
  command: string,
  role: Role,
  gitAliasDepth = 0,
  pushGranted = true,
  lane: LaneContext = {},
): Decision {
  if (command.includes(NUL)) {
    return block("loop-guard: a NUL character cannot appear in a command");
  }
  const parsed = parseCommand(command, role);
  if (!parsed) return fallbackScan(command, role, 0, pushGranted, lane);

  if (parsed.hasBackgroundOperator) {
    return block(
      "loop-guard: a command-terminating `&` (nohup/disown/setsid or a bare background operator) detaches a " +
        "process outside loop-wait; use watch_start for long-running processes instead.",
    );
  }

  for (const rawSegment of parsed.segments) {
    const stripped = stripWrappers(rawSegment);
    if (stripped.length === 0) continue;
    const head = basename(stripped[0]);

    if (head === "nohup" || head === "disown" || head === "setsid") {
      return block(`loop-guard: '${head}' detaches a process outside loop-wait; use watch_start instead.`);
    }

    if (head === "git") {
      // Evaluate the UNEXPANDED command first (main-thread course correction,
      // 2026-09-27): real git ignores an alias whose name shadows a built-in
      // subcommand - `git -c alias.push=status push --force origin main`
      // still runs the real `push --force`, never `status` - so the
      // alias-expanded reading alone would miss it. Rather than hardcode a
      // built-in-name list (which drifts against git's own set), always check
      // the literal subcommand token too and block if either reading blocks.
      const literalDecision = checkGitPushAddCommit(gitArguments(stripped), pushGranted);
      if (literalDecision) return literalDecision;

      const resolved = resolveGitArguments(stripped);
      if (resolved.shellCommand !== undefined) {
        // `git -c alias.<name>=!<shell>` (C4 item 5): the alias runs a shell
        // command, not a git subcommand, so evaluate it exactly like any
        // other nested shell command. Depth-bounded against a pathological
        // alias cycle; past the bound the alias text gets the fallback scan.
        const aliasDecision =
          gitAliasDepth >= MAX_GIT_ALIAS_DEPTH
            ? fallbackScan(resolved.shellCommand, role, 0, pushGranted, lane)
            : evaluateBashCommand(resolved.shellCommand, role, gitAliasDepth + 1, pushGranted, lane);
        if (aliasDecision.block) return aliasDecision;
      } else if (resolved.unparseable) {
        // The alias's own body could not be lexed (e.g. an unterminated
        // quote): never treat it as an inert literal subcommand string.
        const aliasDecision = fallbackScan(resolved.aliasText ?? rawSegment.join(" "), role, 0, pushGranted, lane);
        if (aliasDecision.block) return aliasDecision;
      } else {
        const aliasExpandedDecision = checkGitPushAddCommit(resolved.args, pushGranted);
        if (aliasExpandedDecision) return aliasExpandedDecision;
      }
    }

    if (isInterpreterHead(head)) {
      // Inline code (`python -c`, `node -e`, `perl -pi -e`, ...) is allowed;
      // each argument gets the fallback text scan so a dangerous command
      // spelled out in the code still blocks.
      for (const arg of stripped.slice(1)) {
        const decision = fallbackScan(arg, role, 0, pushGranted, lane);
        if (decision.block) return decision;
      }
    }

    if (role === "lane") {
      const control = loopControlWrite(stripped, lane.cwd);
      if (control) return block(loopControlReason(control));
      const forbidden = classifyLaneForbidden(stripped);
      if (forbidden) {
        if (!lane.ops) return block(`loop-guard: '${forbidden.label}' ${LANE_FORBIDDEN_REASON}.`);
        const refusal = opsRefusal(rawSegment, stripped, forbidden, lane.ops);
        if (refusal) return block(`loop-guard (ops): ${refusal}`);
      }
    }
  }

  if (role === "lane") {
    for (const target of parsed.writeTargets) {
      if (isLoopControlPath(target, lane.cwd)) return block(loopControlReason(target));
    }
  }

  for (const script of parsed.interpreterScripts) {
    const decision = fallbackScan(script, role, 0, pushGranted, lane);
    if (decision.block) return decision;
  }

  return allow();
}

// ---------------------------------------------------------------------------
// Root-only rules: subagent, watch_process, bg_wait (C4 item 4)
// ---------------------------------------------------------------------------

export interface SubagentInput {
  agent?: unknown;
  task?: unknown;
  machine?: unknown;
  acceptance?: unknown;
  gate?: unknown;
  workflow?: unknown;
  action?: unknown;
  async?: unknown;
  workflowScript?: unknown;
  workflowScriptPath?: unknown;
  [key: string]: unknown;
}

/** True for a call shape that launches a child (as opposed to a management,
 *  status, or control action): a direct `{agent, task}` launch, or a workflow
 *  launch via `workflowScript`/`workflowScriptPath`/the named `workflow`
 *  resource field. Used both to decide the agent-allowlist check and to track
 *  "is any async subagent run active" in root.ts. */
export function isSubagentLaunch(input: SubagentInput): boolean {
  if (typeof input.agent === "string" && typeof input.task === "string") return true;
  if (typeof input.workflowScript === "string") return true;
  if (typeof input.workflowScriptPath === "string") return true;
  if (typeof input.workflow === "string") return true;
  return false;
}

/** True for a launch that runs in the background (the default for every
 *  launch shape unless the call explicitly sets `async: false`). */
export function isAsyncSubagentLaunch(input: SubagentInput): boolean {
  return isSubagentLaunch(input) && input.async !== false;
}

export function evaluateSubagentCall(input: SubagentInput): Decision {
  if (input.machine !== undefined) {
    return block("loop-guard: `subagent` calls may not set `machine` (root rule, C4 item 4).");
  }
  if (input.acceptance !== undefined) {
    return block("loop-guard: `subagent` calls may not carry `acceptance` (spawns a shell in the host process).");
  }
  if (input.gate !== undefined) {
    return block("loop-guard: `subagent` calls may not carry `gate` (spawns a shell in the host process).");
  }
  // pi-subagents' own guidance asks for one workflow call holding
  // every child. Appendix C launches each lane as its own async call instead:
  // only single-agent launches get the checkpoint steer before `timeoutMs`,
  // and each lane's completion wakes the root separately. pi-subagents 0.75.0
  // carries a workflow in one `workflow` field (`true` for the reply's js
  // block, a path, or a named resource); the removed `workflowScript` /
  // `workflowScriptPath` stay listed as a backstop. `action: "validate"` with
  // the removed fields launches nothing and stays allowed.
  const carriesWorkflow =
    input.workflow !== undefined || input.workflowScript !== undefined || input.workflowScriptPath !== undefined;
  if (carriesWorkflow && input.action === undefined) {
    return block(
      "loop-guard: workflows are not used in loop-pi (fan-out protocol Appendix C). Launch each lane as its " +
        "own async `subagent` call with {agent, task}; the pi-subagents 'one workflow call' guidance does not " +
        "apply in this home.",
    );
  }
  if (input.workflow !== undefined) {
    return block("loop-guard: `subagent` calls may not carry a `workflow` (it runs host commands or children outside Appendix C).");
  }
  if (isSubagentLaunch(input) && typeof input.agent === "string" && !C3_AGENTS.has(input.agent)) {
    return block(`loop-guard: '${input.agent}' is outside the C3 agent set the root may spawn.`);
  }
  return allow();
}

export function evaluateWatchProcess(asyncRunActive: boolean): Decision {
  if (asyncRunActive) {
    return block(
      "loop-guard: `watch_process` is blocked on the root while an async subagent run is active; it would " +
        "delay a pushed completion. Use `watch_start` instead.",
    );
  }
  return allow();
}

export function evaluateBgWait(): Decision {
  return block("loop-guard: `bg_wait` is blocked; the root waits by push (loop-wait), never a blocking wait tool.");
}
