// Telemetry lane entry: listed in every shipped agent file's `extensions:` allowlist, so each
// child session (nested ones included) loads it. Deliberately not a required child extension: a
// telemetry failure must never fail a lane launch (SEAMS.md "Telemetry").
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTelemetry } from "./core.ts";

export default function (pi: ExtensionAPI): void {
  installTelemetry(pi, "lane");
}
