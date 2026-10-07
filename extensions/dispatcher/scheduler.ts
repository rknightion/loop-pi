// The dispatcher's scheduling core (SEAMS.md S7). No pi, git or process calls: everything outside
// goes through Ports, so tests drive it with fakes.
//
// Rules:
// - Implementation lanes run file-disjoint by owned globs, at most `cap` at once. A task whose files
//   overlap an earlier unfinished task waits for it to land (file order).
// - Lanes land themselves. Each landed return joins the next batch; one gate-runner runs the composed
//   gate on the integrated SHA per batch, one batch at a time.
// - A non-complete return gets one triager lane, which answers retry, park or split. A task stops at
//   ATTEMPT_CEILING implementation attempts.
// - accept and Done only after complete, landed and a green composed gate.
// - A red composed gate stops new work; running lanes drain and the loop closes `blocked`.

import { ATTEMPT_CEILING, failedRunReturn, gateBrief, parseLaneReturn, parseTriage, retryAgent, taskBrief, triageBrief, type LaneReturn } from "./brief.ts";
import { globMatch, guardedHits, ownedOverlap, ownedPatterns, ownedWithin } from "./glob.ts";
import type { TaskSpec } from "./goal.ts";

export type CloseReason = "nothing-admissible" | "owner-stop" | "blocked" | "budget";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface Ports {
  /** Appends one S2 event (without v/seq/ts/by). Throws when the log refuses it. */
  append(event: Record<string, unknown>): Promise<void>;
  /** Spawns one async lane. Resolves to its run id, or an error when the guard or pi-subagents refuses. */
  spawn(agent: string, brief: string): Promise<{ runId: string } | { error: string }>;
  /** The default branch's remote SHA now (fetched). */
  remoteSha(): Promise<string>;
  /** True when `sha` is contained in `tip`. */
  isAncestor(sha: string, tip: string): Promise<boolean>;
  /** Paths touched by any commit on the default branch between two SHAs (per commit, not the net diff). */
  changedFiles(base: string, tip: string): Promise<string[]>;
  backlogDone(task: string): Promise<{ ok: boolean; detail: string }>;
  closeout(): Promise<{ ok: boolean; detail: string }>;
  /** Commits `backlog/` only (explicit pathspec), never pushed. */
  commitBacklog(tasks: string[]): Promise<{ ok: boolean; detail: string }>;
  onClose(): Promise<void>;
  log(message: string): void;
}

export interface DispatchPlan {
  tasks: TaskSpec[];
  /** Effective tier per task id. */
  tiers: Record<string, string>;
  runTier: string;
  cap: number;
  composedGate: string;
  guardedExtra: string[];
  /** Tracked repository files, for the guarded-path check on a triage revision. */
  files: string[];
  goalSha256: string;
  rootModel: string;
}

type Status = "pending" | "running" | "triage" | "awaiting-gate" | "gating" | "accepted" | "parked" | "split";

interface TaskState {
  spec: TaskSpec;
  status: Status;
  attempts: number;
  /** The Envelope entry with any triage revision applied; Gate and Landing never change. */
  current: TaskSpec;
  agent: string;
  sha?: string;
  parent?: string;
  children?: string[];
  lastLane?: string;
  lastBrief?: string;
  lastReturn?: string;
}

interface Lane {
  lane: string;
  kind: "work" | "gate" | "triage";
  tasks: string[];
  brief: string;
  sha?: string;
  failedLane?: string;
  /** The default branch's SHA when the lane was dispatched. */
  base?: string;
}

const FINISHED: ReadonlySet<Status> = new Set(["accepted", "parked", "split"]);
const LANDED: ReadonlySet<Status> = new Set(["awaiting-gate", "gating", "accepted"]);

export class Dispatcher {
  private readonly order: string[] = [];
  private readonly tasks = new Map<string, TaskState>();
  private readonly lanes = new Map<string, Lane>();
  private readonly early = new Map<string, { text: string; failed: boolean }>();
  private laneSeq = 0;
  private readonly markedDone: string[] = [];
  private gateRunning = false;
  private halted = false;
  private closing = false;
  private reason: CloseReason = "nothing-admissible";
  private chain: Promise<void> = Promise.resolve();
  private resolveDone!: (reason: CloseReason) => void;
  readonly done: Promise<CloseReason>;

  private readonly plan: DispatchPlan;
  private readonly ports: Ports;

  constructor(plan: DispatchPlan, ports: Ports) {
    this.plan = plan;
    this.ports = ports;
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
    for (const spec of plan.tasks) this.addTask(spec);
  }

  private addTask(spec: TaskSpec, parent?: string, after?: string): void {
    this.tasks.set(spec.id, { spec, status: "pending", attempts: 0, current: spec, agent: spec.agent, parent });
    if (after === undefined) this.order.push(spec.id);
    else {
      const at = this.order.indexOf(after);
      this.order.splice(at + 1, 0, spec.id);
    }
  }

  /** Opens the log, admits the Envelope, and starts dispatching. */
  start(): Promise<CloseReason> {
    this.serial(async () => {
      await this.ports.append({
        ev: "open",
        goal_sha256: this.plan.goalSha256,
        tier: this.plan.runTier,
        root: "dispatcher",
        root_model: this.plan.rootModel,
        envelope: this.plan.tasks.map((t) => t.id),
      });
      for (const t of this.plan.tasks) {
        await this.ports.append({
          ev: "admit",
          task: t.id,
          source: "envelope",
          owned: t.owned,
          accept: t.acceptance,
          tier: this.plan.tiers[t.id],
          surfaces: guardedHits(t.owned, this.plan.guardedExtra, this.plan.files),
        });
      }
      await this.pump();
    });
    return this.done;
  }

  /** A lane finished: `text` is its final message, `failed` whether pi-subagents reported the run failed or
   * timed out. Unknown run ids are kept until their spawn reply. */
  complete(runId: string, text: string, failed = false): void {
    this.serial(async () => {
      const lane = this.lanes.get(runId);
      if (!lane) {
        this.early.set(runId, { text, failed });
        return;
      }
      await this.handleReturn(runId, lane, text, failed);
      await this.pump();
    });
  }

  private serial(step: () => Promise<void>): void {
    this.chain = this.chain.then(step).catch(async (error) => {
      this.ports.log(`dispatcher: ${error instanceof Error ? error.message : String(error)}`);
      this.halted = true;
      this.reason = "blocked";
      await this.pump().catch(() => {});
    });
  }

  private nextLane(): string {
    this.laneSeq += 1;
    return `L${this.laneSeq}`;
  }

  private runningWork(): TaskState[] {
    return [...this.tasks.values()].filter((t) => t.status === "running" || t.status === "triage");
  }

  private admissible(): TaskState | undefined {
    const busy = this.runningWork();
    for (let index = 0; index < this.order.length; index++) {
      const t = this.tasks.get(this.order[index])!;
      if (t.status !== "pending") continue;
      if (busy.some((b) => ownedOverlap(b.current.owned, t.current.owned))) continue;
      const blockedByEarlier = this.order
        .slice(0, index)
        .map((id) => this.tasks.get(id)!)
        .some((e) => !FINISHED.has(e.status) && !LANDED.has(e.status) && e.status !== "triage" && ownedOverlap(e.current.owned, t.current.owned));
      if (blockedByEarlier) continue;
      return t;
    }
    return undefined;
  }

  private async pump(): Promise<void> {
    if (this.closing) return;
    if (!this.halted) {
      while (!this.halted && this.runningWork().length < this.plan.cap) {
        const t = this.admissible();
        if (!t) break;
        await this.dispatchWork(t);
      }
      const batch = [...this.tasks.values()].filter((t) => t.status === "awaiting-gate");
      if (!this.gateRunning && batch.length) await this.dispatchGate(batch);
    }
    if (this.lanes.size === 0 && !this.gateRunning) {
      const waiting = [...this.tasks.values()].some((t) => t.status === "awaiting-gate");
      if (!waiting || this.halted) await this.close();
    }
  }

  /** Why the last spawnLane call refused, for the park reason. */
  private refusal = "";

  private async spawnLane(agent: string, lane: Lane, task: string): Promise<boolean> {
    this.refusal = "";
    // Read main before the spawn: a lane that pushes at once must still show up as a change since its base.
    // A gate lane reuses the tip dispatchGate just fetched. A failed fetch refuses the spawn like any refusal.
    try {
      lane.base = lane.kind === "gate" && lane.sha ? lane.sha : await this.ports.remoteSha();
    } catch (error) {
      // Main cannot be read, so no later spawn can be checked either: stop rather than drain the queue.
      this.refusal = `no dispatch base: ${errorText(error)}`;
      this.ports.log(`dispatcher: spawn of ${lane.lane} (${agent}) refused: ${this.refusal}`);
      this.halt();
      return false;
    }
    const result = await this.ports.spawn(agent, lane.brief);
    if ("error" in result) {
      this.ports.log(`dispatcher: spawn of ${lane.lane} (${agent}) refused: ${result.error}`);
      return false;
    }
    this.lanes.set(result.runId, lane);
    const tiers = lane.tasks.map((id) => this.plan.tiers[id]);
    const tier = tiers.every((value) => value === "routine" || value === "guarded")
      ? (tiers.includes("guarded") ? "guarded" : "routine") : undefined;
    const surfaces = [...new Set(lane.tasks.flatMap((id) => {
      const spec = this.tasks.get(id)?.current;
      return spec ? guardedHits(spec.owned, this.plan.guardedExtra, this.plan.files) : [];
    }))];
    await this.ports.append({
      ev: "dispatch", lane: lane.lane, task, tasks: lane.tasks, kind: lane.kind,
      agent, run: result.runId, base: lane.base,
      ...(tier ? { tier } : {}), ...(surfaces.length ? { surface: surfaces.join(", ") } : {}),
    });
    const early = this.early.get(result.runId);
    if (early !== undefined) {
      this.early.delete(result.runId);
      await this.handleReturn(result.runId, lane, early.text, early.failed);
    }
    return true;
  }

  private async dispatchWork(t: TaskState): Promise<void> {
    const lane = this.nextLane();
    const brief = taskBrief(t.current, lane, this.plan.tiers[t.spec.id]);
    t.status = "running";
    t.attempts += 1;
    t.lastLane = lane;
    t.lastBrief = brief;
    const agent = t.attempts > 1 ? retryAgent(t.agent) : t.agent;
    if (!(await this.spawnLane(agent, { lane, kind: "work", tasks: [t.spec.id], brief }, t.spec.id))) {
      await this.park(t, "defect", `spawn refused for ${agent}${this.refusal ? `: ${this.refusal}` : ""}`, lane);
    }
  }

  private async dispatchGate(batch: TaskState[]): Promise<void> {
    const tip = await this.ports.remoteSha();
    const gated: TaskState[] = [];
    for (const t of batch) {
      if (t.sha && (await this.ports.isAncestor(t.sha, tip))) gated.push(t);
      else await this.park(t, "defect", `reported landed SHA ${t.sha ?? "(none)"} is not on the default branch at ${tip}`);
    }
    if (!gated.length) return;
    const ids = gated.map((t) => t.spec.id);
    const lane = this.nextLane();
    const brief = gateBrief(lane, ids, this.plan.runTier, tip, this.plan.composedGate);
    for (const t of gated) t.status = "gating";
    this.gateRunning = true;
    if (!(await this.spawnLane("gate-runner", { lane, kind: "gate", tasks: ids, brief, sha: tip }, ids.join(",")))) {
      this.gateRunning = false;
      for (const t of gated) await this.park(t, "defect", "the composed gate-runner could not be spawned", lane);
      this.halt();
    }
  }

  private halt(): void {
    this.halted = true;
    this.reason = "blocked";
  }

  private async handleReturn(runId: string, lane: Lane, text: string, failed = false): Promise<void> {
    this.lanes.delete(runId);
    const reported = parseLaneReturn(text);
    const r = failed ? failedRunReturn(reported) : reported;
    await this.ports.append(returnEvent(lane.lane, runId, r));
    if (lane.kind === "gate") return this.handleGate(lane, r);
    const t = this.tasks.get(lane.tasks[0])!;
    if (lane.kind === "work" && reported.landed && reported.sha && (failed || reported.status !== "complete")) {
      // The lane may have pushed without finishing: that commit is ungated, and a retry or an overlapping
      // task would build on it. A parked task holds no files, so stop new work.
      let where = "main not checked";
      try {
        const tip = await this.ports.remoteSha();
        where = (await this.ports.isAncestor(reported.sha, tip)) ? `on main at ${tip}` : `not on main at ${tip}`;
      } catch (error) {
        where = `main not checked: ${errorText(error)}`;
      }
      const how = failed ? "failed or timed out" : `returned ${reported.status}`;
      return this.parkPushed(t, lane, text, `lane ${lane.lane} ${how} after reporting landed at ${reported.sha} (${where}); never gated`);
    }
    if (lane.kind === "triage") {
      // A failed or timed-out triager's decision block may be unfinished: park rather than act on it.
      if (failed) return this.park(t, "defect", `triager ${lane.lane} failed or timed out`, lane.lane);
      return this.handleTriage(t, text, lane.lane);
    }
    t.lastReturn = lastReturnBlock(text);
    if (r.status === "complete" && r.landed && r.sha) {
      t.sha = r.sha;
      t.status = "awaiting-gate";
      const land = { ev: "land", task: t.spec.id, sha: r.sha, gate: r.check || t.spec.gate, lane: lane.lane, ...(r.ci ? { ci: r.ci } : {}) };
      await this.ports.append({ ...land, mode: "after-green" });
      return;
    }
    if (lane.kind === "work" && !(r.status === "complete" && r.landed && r.sha)) {
      // No landed claim, yet the lane may still have pushed. Owned files are disjoint across live lanes, so a
      // change to this task's files on main since dispatch is this lane's; never retry on top of it.
      const pushed = await this.ownedChangesSince(t, lane);
      if (pushed) return this.parkPushed(t, lane, text, `lane ${lane.lane} returned ${r.status} without a landed claim, but ${pushed}; never gated`);
    }
    if (this.halted) return this.park(t, "defect", `lane ${lane.lane} returned ${r.status} after the loop halted`, lane.lane);
    if (t.attempts >= ATTEMPT_CEILING) {
      return this.park(t, "defect", `attempt ceiling ${ATTEMPT_CEILING} reached; last return ${r.status}`, lane.lane);
    }
    const triager = this.nextLane();
    const brief = triageBrief(triager, t.spec, this.plan.tiers[t.spec.id], lane.lane, t.lastBrief ?? "", t.lastReturn || "(no lane-return block)", t.attempts);
    t.status = "triage";
    if (!(await this.spawnLane("triager", { lane: triager, kind: "triage", tasks: [t.spec.id], brief, failedLane: lane.lane }, t.spec.id))) {
      await this.park(t, "defect", "the triager could not be spawned", lane.lane);
    }
  }

  /** Parks a task whose lane may have pushed an ungated commit, and stops new work. */
  private async parkPushed(t: TaskState, lane: Lane, text: string, reason: string): Promise<void> {
    t.lastReturn = lastReturnBlock(text);
    await this.park(t, "owner", reason, lane.lane);
    this.halt();
  }

  /** Why this task's owned files may have changed on main since the lane's dispatch, or undefined. */
  private async ownedChangesSince(t: TaskState, lane: Lane): Promise<string | undefined> {
    try {
      if (!lane.base) return "its dispatch base is unknown";
      const tip = await this.ports.remoteSha();
      const owned = t.current.owned.flatMap(ownedPatterns);
      const hits = (await this.ports.changedFiles(lane.base, tip)).filter((f) => owned.some((g) => globMatch(f, g)));
      return hits.length ? `its owned files changed on main since ${lane.base}: ${hits.slice(0, 5).join(", ")}` : undefined;
    } catch (error) {
      return `main could not be checked (${errorText(error)})`;
    }
  }

  private async handleGate(lane: Lane, r: LaneReturn): Promise<void> {
    this.gateRunning = false;
    // Green needs a parsed return that says complete, exit 0, and (when it names one) the gated SHA.
    // The event records what the lane reported: a null exit stays null, and a gate run on another
    // SHA is recorded against that SHA, never as a gate of this batch's tip.
    const onTip = r.sha === null || r.sha === lane.sha;
    const green = r.parsed && r.status === "complete" && r.exit === 0 && onTip;
    // A failed or timed-out gate run reported no real exit, whatever its block claims.
    const exit = r.runFailed ? null : r.exit;
    await this.ports.append({ ev: "gate", scope: "composed", sha: r.sha ?? lane.sha!, cmd: this.plan.composedGate, exit, lane: lane.lane });
    const red = r.runFailed
      ? `composed gate run at ${lane.sha} failed or timed out`
      : !r.parsed
      ? `composed gate at ${lane.sha} returned no lane-return block`
      : !onTip
        ? `composed gate ran on ${r.sha}, not the batch tip ${lane.sha}`
        : `composed gate red at ${lane.sha} (status ${r.status}, exit ${r.exit === null ? "null" : r.exit})`;
    for (const id of lane.tasks) {
      const t = this.tasks.get(id)!;
      if (green) await this.accept(t, `complete, landed at ${t.sha}, composed gate green at ${lane.sha}`, lane.lane);
      else {
        await this.ports.append({ ev: "accept", task: id, accepted: false, reason: red, lane: lane.lane });
        await this.park(t, "defect", red, lane.lane);
      }
    }
    if (!green) this.halt();
  }

  private async accept(t: TaskState, reason: string, lane?: string): Promise<void> {
    t.status = "accepted";
    await this.ports.append({ ev: "accept", task: t.spec.id, accepted: true, reason, ...(lane ? { lane } : {}) });
    if (!t.parent) {
      const done = await this.ports.backlogDone(t.spec.id);
      if (done.ok) this.markedDone.push(t.spec.id);
      if (!done.ok) this.ports.log(`dispatcher: backlog Done for ${t.spec.id} failed: ${done.detail}`);
      return;
    }
    const parent = this.tasks.get(t.parent)!;
    if (parent.children!.every((c) => this.tasks.get(c)!.status === "accepted")) {
      await this.accept(parent, `all split subtasks accepted (${parent.children!.join(", ")})`);
    }
  }

  private async park(t: TaskState, needs: string, reason: string, lane?: string): Promise<void> {
    t.status = "parked";
    await this.ports.append({ ev: "park", task: t.spec.id, reason, needs, ...(lane ? { lane } : {}) });
  }

  private async handleTriage(t: TaskState, text: string, lane: string): Promise<void> {
    const d = parseTriage(text);
    if (this.halted) return this.park(t, "defect", `loop halted before triage could act (${d.action})`, lane);
    if (d.action === "none") return this.park(t, "defect", d.reason, lane);
    if (d.action === "park") return this.park(t, d.needs, d.reason, lane);
    const outside = (owned: string[]) => !owned.every((o) => ownedWithin(o, t.spec.owned)) || guardedHits(owned, this.plan.guardedExtra, this.plan.files).length > 0;
    if (d.action === "retry") {
      if (outside(d.brief.owned)) return this.park(t, "defect", `retry rejected: owned files ${d.brief.owned.join(", ")} leave the task's files or touch guarded paths`, lane);
      t.current = { ...t.spec, ...d.brief, stop: d.brief.stop ?? t.spec.stop, escalation: d.brief.escalation ?? t.spec.escalation };
      t.status = "pending";
      return;
    }
    if (t.parent) return this.park(t, "defect", "a split subtask may not split again", lane);
    const bad = d.tasks.find((c) => outside(c.owned));
    if (bad) return this.park(t, "defect", `split rejected: owned files ${bad.owned.join(", ")} leave the task's files or touch guarded paths`, lane);
    t.status = "split";
    t.children = [];
    let after = t.spec.id;
    for (const [k, c] of d.tasks.entries()) {
      const spec: TaskSpec = { ...t.spec, id: `${t.spec.id}.${k + 1}`, ...c, stop: c.stop ?? t.spec.stop, escalation: c.escalation ?? t.spec.escalation };
      this.plan.tiers[spec.id] = this.plan.tiers[t.spec.id];
      this.addTask(spec, t.spec.id, after);
      after = spec.id;
      t.children.push(spec.id);
      await this.ports.append({ ev: "admit", task: spec.id, source: "loop-created", owned: spec.owned, accept: spec.acceptance, tier: this.plan.tiers[spec.id], surfaces: guardedHits(spec.owned, this.plan.guardedExtra, this.plan.files) });
    }
  }

  private async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const step = async (what: string, run: () => Promise<void>) => {
      try {
        await run();
      } catch (error) {
        this.ports.log(`dispatcher: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
        this.reason = "blocked";
      }
    };
    for (const t of this.tasks.values()) {
      if (t.status === "awaiting-gate") await step(`park ${t.spec.id}`, () => this.park(t, "defect", "landed after the loop halted; never gated"));
    }
    await step("loop-pi-audit closeout", async () => {
      const audit = await this.ports.closeout();
      if (!audit.ok) throw new Error(audit.detail);
    });
    await step("close event", () => this.ports.append({ ev: "close", reason: this.reason }));
    if (this.markedDone.length) {
      await step("backlog commit", async () => {
        const commit = await this.ports.commitBacklog(this.order.filter((id) => this.markedDone.includes(id)));
        if (!commit.ok) throw new Error(commit.detail);
      });
    }
    await step("onClose", () => this.ports.onClose());
    this.resolveDone(this.reason);
  }

  /** Resolves once every queued event has been handled. */
  settled(): Promise<void> {
    return this.chain;
  }

  /** Task states, for tests and the final summary line. */
  snapshot(): Record<string, { status: Status; attempts: number }> {
    return Object.fromEntries(this.order.map((id) => [id, { status: this.tasks.get(id)!.status, attempts: this.tasks.get(id)!.attempts }]));
  }
}

function lastReturnBlock(text: string): string {
  const m = [...text.matchAll(/```lane-return[\s\S]*?```/g)];
  return m.length ? m[m.length - 1][0] : text.slice(-2000);
}

export function returnEvent(lane: string, run: string, r: LaneReturn): Record<string, unknown> {
  const ev: Record<string, unknown> = { ev: "return", lane, run, status: r.status, sha: r.sha, landed: r.landed, exit: r.exit, ci: r.ci };
  if (r.check) ev.check = r.check;
  if (r.base) ev.base = r.base;
  if (r.coderabbit) ev.coderabbit = r.coderabbit;
  if (r.questions.length) ev.questions = r.questions;
  return ev;
}
