// pi-subagents 0.90.0 `disabledFeatures: ["session-sharing"]` removes `share` from the subagent tool,
// so no run can upload a session to a GitHub Gist (a secret Gist is unlisted, not private).
// The loop home turns it off; this pins the home config against the package's own feature surface.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  disabledFeatureUseError,
  resolveDisabledFeatureSurface,
  validateDisabledFeatures,
} from "../node_modules/pi-subagents/src/shared/disabled-features.js";

const home = JSON.parse(readFileSync(new URL("../home/extensions/subagent/config.json", import.meta.url), "utf8"));

test("the loop home disables session sharing, so a share request is refused before it starts", () => {
  validateDisabledFeatures(home.disabledFeatures);
  const surface = resolveDisabledFeatureSurface(home);
  const refused = disabledFeatureUseError({ agent: "worker", task: "t", share: true }, surface);
  assert.match(refused ?? "", /option 'share' is disabled by config disabledFeatures "session-sharing"/);
  assert.equal(disabledFeatureUseError({ agent: "worker", task: "t" }, surface), undefined, "an ordinary launch is unaffected");
});
