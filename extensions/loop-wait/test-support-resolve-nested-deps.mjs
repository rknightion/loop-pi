// Test-only ESM resolution hook. lane.ts and root.ts import "typebox", which is a dependency of
// @earendil-works/pi-coding-agent, not of this repository: it resolves through pi's own jiti-based
// extension loader at runtime. Running the real pi CLI (as every other RPC test in this directory
// does) goes through that loader and just works. A plain `node --test` process directly importing
// lane.ts/root.ts as ordinary ES modules — to unit-test their wiring without paying for a whole
// CLI subprocess — has no such loader. Whether npm nests typebox under pi-coding-agent's own
// node_modules or hoists it to the top level depends on the pi release (a published
// npm-shrinkwrap.json nests it), so this hook resolves the bare "typebox" specifier exactly as
// pi-coding-agent itself would, from pi-coding-agent's package directory. It touches no
// node_modules or package.json/lockfile; the name is prefixed "test-" so bin/loop-pi-install's
// source_files() filter excludes it from every installed build, same as every other file in this
// directory named that way.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_PACKAGE_JSON = pathToFileURL(
  join(HERE, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "typebox") {
    return nextResolve(specifier, { ...context, parentURL: PI_PACKAGE_JSON });
  }
  return nextResolve(specifier, context);
}
