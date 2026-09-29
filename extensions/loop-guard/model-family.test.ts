import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedModel, modelFamilyConfig, refusedPayload, subagentModelOverrides, subagentOverrideBlock } from "./model-family.ts";

test("only the gpt-6 family on openai is allowed", () => {
  for (const id of ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"]) assert.ok(isAllowedModel("openai", id), id);
  for (const id of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5", "gpt-60", "gpt-6-sol-x/../gpt-5"]) {
    assert.ok(!isAllowedModel("openai", id), id);
  }
  assert.ok(!isAllowedModel("amazon-bedrock", "global.openai.gpt-6-sol"));
  assert.ok(isAllowedModel("faux", "faux-1"), "test-only provider");
});

test("any subagent model override is found wherever it sits: agent files pin the route", () => {
  assert.deepEqual(subagentModelOverrides({ agent: "lane-worker", task: "x" }), []);
  assert.deepEqual(subagentModelOverrides({ model: "openai/gpt-6-luna:max" }), ["openai/gpt-6-luna:max"]);
  assert.deepEqual(
    subagentModelOverrides({ tasks: [{ agent: "a", model: "openai/gpt-5.6-luna" }], chain: [{ model: { id: "gpt-5.5" } }] }),
    ["openai/gpt-5.6-luna", '{"id":"gpt-5.5"}'],
  );
});

test("a request for a model outside the family is sent under a model name the provider rejects", () => {
  assert.equal(refusedPayload({ provider: "openai", id: "gpt-6-sol" }, { model: "gpt-6-sol" }), undefined);
  assert.deepEqual(refusedPayload({ provider: "openai", id: "gpt-5.6-sol" }, { model: "gpt-5.6-sol", input: [] }), {
    model: "loop-pi-refused:gpt-5.6-sol",
    input: [],
  });
});

test("a subagent call may not shorten or reset a run deadline: agent files pin it", () => {
  assert.equal(subagentOverrideBlock({ agent: "mapper", task: "x" }), undefined);
  // A host acceptance gate's own timeout is not a run deadline.
  assert.equal(subagentOverrideBlock({ agent: "gate-runner", acceptance: { command: "just test", timeoutMs: 600000 } }), undefined);
  for (const input of [
    { agent: "mapper-deep", task: "x", timeoutMs: 1500000 },
    { agent: "mapper", maxRuntimeMs: 900000 },
    { tasks: [{ agent: "gate-runner", task: "x", timeoutMs: 1800000 }] },
  ]) {
    assert.match(subagentOverrideBlock(input)?.reason ?? "", /run deadline/, JSON.stringify(input));
  }
  assert.match(subagentOverrideBlock({ agent: "mapper", model: "gpt-6-luna" })?.reason ?? "", /model override/);
});

test("the family and the fallback route come from settings loopPi, defaulting to gpt-6 on openai", () => {
  const defaults = modelFamilyConfig({});
  assert.deepEqual(defaults, modelFamilyConfig({ loopPi: {} }));
  assert.equal(defaults.name, "gpt-6");
  assert.deepEqual(defaults.fallback, { provider: "openai", id: "gpt-6-sol" });
  const custom = modelFamilyConfig({
    loopPi: {
      modelFamily: { provider: "example", pattern: "^model-7(-[a-z]+)+$", name: "model-7", members: ["model-7-large"] },
      rootRoute: { provider: "example", model: "model-7-large", thinking: "high" },
    },
  });
  assert.ok(isAllowedModel("example", "model-7-large", custom));
  assert.ok(!isAllowedModel("openai", "gpt-6-sol", custom));
  assert.ok(isAllowedModel("faux", "faux-1", custom), "test-only provider");
  assert.deepEqual(custom.fallback, { provider: "example", id: "model-7-large" });
  assert.equal(refusedPayload({ provider: "openai", id: "gpt-6-sol" }, { model: "gpt-6-sol" }, custom) !== undefined, true);
  assert.match(subagentOverrideBlock({ agent: "a", model: "x" }, custom)?.reason ?? "", /model-7 family route \(model-7-large\)/);
  // A pattern that does not compile is not a way to open the guard: the defaults apply.
  assert.deepEqual(modelFamilyConfig({ loopPi: { modelFamily: { provider: "example", pattern: "(" } } }), defaults);
});
