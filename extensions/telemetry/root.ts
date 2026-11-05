// Telemetry root entry: loaded by the launcher's `--extension` flag (SEAMS.md "Telemetry").
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTelemetry } from "./core.ts";

export default function (pi: ExtensionAPI): void {
  installTelemetry(pi, "root");
}
