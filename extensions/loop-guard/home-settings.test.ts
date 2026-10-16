// The home's enabledModels is what pi offers for model selection; it must not admit a model the
// loop-guard family refuses (a wildcard such as "openai/gpt-6-*" admitted gpt-6-sol).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { modelFamilyConfig } from "./model-family.ts";

const settings = JSON.parse(readFileSync(new URL("../../home/settings.json", import.meta.url), "utf8"));

test("home enabledModels lists exactly the loop model family", () => {
  const family = modelFamilyConfig(settings);
  const expected = family.members.map((id) => `${family.provider}/${id}`).sort();
  assert.deepEqual([...settings.enabledModels].sort(), expected);
});
