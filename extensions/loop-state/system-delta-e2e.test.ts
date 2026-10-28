// Native Pi RPC + faux provider: loop-state's request rewrite must keep mid-conversation system
// messages where pi put them. pi 1.4.0 folds every system message into one new leading message when
// a `context` handler changes the list, so a prompt-section update (pi-subagents updates
// `advertised_subagents` several times a session) would change the request from its first token and
// miss the whole prompt cache. loop-state rewrites in `context_with_system`, which pi uses as returned.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupAll, FAUX_EXTENSION, freshDir, startPiRpc, writeFauxScript } from "../loop-guard/rpc-test-helpers.ts";

const STATE = fileURLToPath(new URL("./index.ts", import.meta.url));
after(() => cleanupAll());

type Message = { role?: string; content?: unknown; sections?: Record<string, string> };
const textOf = (m: Message) =>
  typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? "").join("") : "";

test("a marked loop-pi notice keeps a later prompt-section update in place in the provider request", { timeout: 60_000 }, async () => {
  const dir = freshDir("loop-state-system-delta-");
  const requests = join(dir, "requests.jsonl");
  const probe = join(dir, "probe.ts");
  // SEND_NOTICE adds a loop-pi notice to the run (loop-state marks it); CHANGE_SECTION changes one
  // prompt section, which pi records as a mid-conversation system message.
  writeFileSync(probe, `export default function (pi) {
  pi.on("before_agent_start", (e) => {
    if (e.messageType !== "user") return;
    if (/CHANGE_SECTION/.test(e.prompt)) e.systemPromptOptions.sections.probe = "PROBE_SECTION_V2";
    if (/SEND_NOTICE/.test(e.prompt)) return { message: { customType: "loop-wake", content: "LOOP_NOTICE_TEXT", display: true } };
  });
}
`);
  const session = startPiRpc({
    extensions: [FAUX_EXTENSION, STATE, probe],
    fauxScriptPath: writeFauxScript([{ match: ".*", text: "ok" }]),
    agentDir: freshDir("loop-state-system-delta-agent-"),
    subagentTempRoot: freshDir("loop-state-system-delta-sub-"),
    cwd: freshDir("loop-state-system-delta-cwd-"),
    env: { LOOP_PI_FAUX_REQUEST_LOG: requests },
  });
  try {
    for (const message of ["SEND_NOTICE one", "CHANGE_SECTION two", "three"]) {
      const settled = session.events.filter((e) => e.type === "agent_settled").length;
      session.send({ type: "prompt", id: message, message });
      await session.waitFor((e) => e.type === "agent_settled" && session.events.filter((x) => x.type === "agent_settled").length > settled);
    }
    const request: Message[] = readFileSync(requests, "utf8").trim().split("\n").map((line: string) => JSON.parse(line)).at(-1);
    assert.ok(
      request.some((m) => m.role === "user" && textOf(m).includes('<loop_pi_notice type="loop-wake"')),
      "loop-state marked its notice in this request",
    );
    const systems = request.flatMap((m, index) => (m.role === "system" ? [index] : []));
    assert.equal(systems[0], 0, "the request starts with the original system message");
    assert.ok(!JSON.stringify(request[0]).includes("PROBE_SECTION_V2"), "the leading system message is the original, not a refolded prompt");
    assert.ok(
      systems.slice(1).some((index) => JSON.stringify(request[index]).includes("PROBE_SECTION_V2")),
      "the section update stays as a mid-conversation system message",
    );
  } finally {
    await session.close();
  }
});
