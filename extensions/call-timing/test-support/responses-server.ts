// Local scripted Responses SSE server for progress and retry tests. Not a test file. Each request is
// served the next script; the request body (the prompt) is drained and never stored or logged unless
// a test asks to keep bodies. Frames use the wire shapes the pinned OpenAI client parses:
// `event: <type>` plus a JSON `data:` line. A script with an `httpError` step answers with that status
// and a fixed JSON error body; one that starts with `http` answers with that status and its own JSON
// body; `destroy` cuts the connection where it stands.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Step =
  | { frame: Record<string, unknown>; mark?: string }
  | { comment: string }
  | { sleepMs: number }
  | { hang: true }
  | { httpError: number; headers?: Record<string, string> }
  | { http: number; body: unknown; headers?: Record<string, string> }
  | { destroy: true };

export interface ResponsesServer {
  baseUrl: string;
  marks: Record<string, number>;
  requests: () => number;
  /** Parsed request bodies, only when the server was started with `keepBodies`. */
  bodies: () => unknown[];
  close: () => Promise<void>;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startResponsesServer(scripts: Step[][], fallback: Step[], opts: { keepBodies?: boolean } = {}): Promise<ResponsesServer> {
  const marks: Record<string, number> = {};
  const open = new Set<ServerResponse>();
  const kept: unknown[] = [];
  let served = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { if (opts.keepBodies) raw += chunk; });
    req.on("end", async () => {
      if (opts.keepBodies) { try { kept.push(JSON.parse(raw)); } catch { kept.push(null); } }
      const script = scripts[served++] ?? fallback;
      open.add(res);
      res.on("close", () => open.delete(res));
      const failure = script.find((step): step is { httpError: number; headers?: Record<string, string> } => "httpError" in step);
      if (failure) {
        // An HTTP error before any stream: a JSON error body with the same correlation headers.
        res.writeHead(failure.httpError, { "content-type": "application/json", "x-request-id": `fixture-request-${served}`, "x-ratelimit-remaining-requests": "0", ...failure.headers });
        res.end(JSON.stringify({ error: { message: "fixture bad request", type: "invalid_request_error", code: "fixture_bad_request" } }));
        return;
      }
      const first = script[0];
      if (first && "http" in first) {
        // An HTTP error with a scripted status and JSON body.
        res.writeHead(first.http, { "content-type": "application/json", "x-request-id": `fixture-request-${served}`, ...first.headers });
        res.end(JSON.stringify(first.body));
        return;
      }
      if (first && "destroy" in first) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": `fixture-request-${served}` });
      res.flushHeaders();
      for (const step of script) {
        if (res.destroyed) return;
        if ("httpError" in step) continue;
        if ("sleepMs" in step) await pause(step.sleepMs);
        else if ("hang" in step) return;
        else if ("destroy" in step) { res.socket?.destroy(); return; }
        else if ("http" in step) continue;
        else if ("comment" in step) res.write(`: ${step.comment}\n\n`);
        else {
          res.write(`event: ${step.frame.type}\ndata: ${JSON.stringify(step.frame)}\n\n`);
          if (step.mark) marks[step.mark] = Date.now();
        }
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    marks,
    requests: () => served,
    bodies: () => [...kept],
    close: () => new Promise<void>((resolve) => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
