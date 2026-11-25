import assert from "node:assert/strict";
import { test } from "node:test";
import { findPython315 } from "./core.ts";

const none = () => null;
const only = (...files: string[]) => (file: string) => files.includes(file);

test("python3.15 on an absolute PATH entry wins over Homebrew", () => {
  const found = findPython315({ path: "/usr/bin:/opt/x/bin", homebrew: ["/b/python3.15"], uvFind: none, executable: only("/opt/x/bin/python3.15", "/b/python3.15") });
  assert.equal(found, "/opt/x/bin/python3.15");
});

test("a relative or empty PATH entry never supplies the interpreter", () => {
  const found = findPython315({ path: ".::bin", homebrew: [], uvFind: none, executable: () => true });
  assert.equal(found, null);
});

test("Homebrew's python3.15 is used when PATH has none", () => {
  const found = findPython315({ path: "/usr/bin", homebrew: ["/a/python3.15", "/b/python3.15"], uvFind: none, executable: only("/b/python3.15") });
  assert.equal(found, "/b/python3.15");
});

test("a 3.15 that uv resolves is used last, and a virtual environment's is refused", () => {
  const base = { path: "/usr/bin", homebrew: [], exists: () => false };
  assert.equal(findPython315({ ...base, uvFind: () => "/u/py/bin/python3.15", executable: only("/u/py/bin/python3.15") }), "/u/py/bin/python3.15");
  assert.equal(findPython315({ ...base, uvFind: () => "/repo/.venv/bin/python", executable: only("/repo/.venv/bin/python") }), null);
  assert.equal(findPython315({ ...base, uvFind: () => "/v/bin/python", executable: only("/v/bin/python"), exists: (f) => f === "/v/pyvenv.cfg" }), null);
});

test("the system python3 is never a fallback", () => {
  const found = findPython315({ path: "/usr/bin", homebrew: [], uvFind: none, executable: only("/usr/bin/python3") });
  assert.equal(found, null);
});
