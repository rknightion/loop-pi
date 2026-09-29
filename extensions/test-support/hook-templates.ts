// Where the loop-guard tests find guard scripts to copy into a scratch <agentDir>/scripts/.
// The sample guards beside this file.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The sample guards shipped for tests and as examples of the hook contract. */
export const SAMPLE_HOOK_SCRIPTS_DIR = join(here, "hook-scripts");


/** The guard scripts the adapter tests run. */
export const HOOK_TEMPLATES_DIR = SAMPLE_HOOK_SCRIPTS_DIR;
