// Test-only ESM resolution hook. lane.ts and root.ts import "typebox", which (per SEAMS.md's
// note about "@earendil-works/pi-ai") resolves only through pi's own jiti-based extension loader
// at runtime: it is nested under @earendil-works/pi-coding-agent's own node_modules, not hoisted
// to the top level. Running the real pi CLI (as every other RPC test in this directory does)
// goes through that loader and just works. A plain `node --test` process directly importing
// lane.ts/root.ts as ordinary ES modules — to unit-test their wiring without paying for a whole
// CLI subprocess — has no such loader, so the bare "typebox" specifier 404s under Node's normal
// resolution. This hook redirects exactly that specifier to its real nested file. It touches no
// node_modules or package.json/lockfile; the name is prefixed "test-" so bin/loop-pi-install's
// source_files() filter excludes it from every installed build, same as every other file in this
// directory named that way.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPEBOX_ENTRY = join(
  HERE,
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
  "typebox",
  "build",
  "index.mjs",
);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "typebox") {
    return { url: pathToFileURL(TYPEBOX_ENTRY).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
