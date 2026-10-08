import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { modelChat, modelConfigured, type ChatTurn } from "../chat/claude.ts";
import { routeMessage, type ChatReply } from "../chat/router.ts";
import { isToolName, replayRun, runTool, TOOLS, type RunRecord } from "../engine/engine.ts";
import { InputError } from "../engine/money.ts";
import { ENGINE_VERSION } from "../engine/version.ts";
import type { LeadSink } from "../leads/store.ts";
import type { RunLog } from "../runlog/store.ts";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../../public/", import.meta.url)));
const MAX_BODY = 64 * 1024;

// Phase 1 serves only the no-login public tools. Signed-in and carrier tenants
// arrive with auth; until then the tenant is never taken from the request.
const TENANT = "public";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Fixed-window limiter per client address. In-memory; move to the edge or Redis when scaled out. */
class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 });
      if (this.hits.size > 10_000) this.sweep(now);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private sweep(now: number) {
    for (const [key, entry] of this.hits) if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
}

/**
 * The caller's address for rate limiting. Behind a reverse proxy (Azure Container
 * Apps ingress) every socket comes from the proxy, so with trustProxy the address
 * is the last X-Forwarded-For entry: the one the proxy itself appended. Earlier
 * entries are client-supplied and can be forged.
 */
export function clientKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers["x-forwarded-for"];
    const last = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function parseHistory(body: unknown): ChatTurn[] {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    throw new HttpError(400, "messages must be a list of 1 to 40 turns.");
  }
  const turns = messages.map((m): ChatTurn => {
    const role = (m as ChatTurn)?.role;
    const content = (m as ChatTurn)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim() || content.length > 4000) {
      throw new HttpError(400, "Each turn needs a role (user or assistant) and text up to 4,000 characters.");
    }
    return { role, content };
  });
  if (turns.at(-1)?.role !== "user") throw new HttpError(400, "The last turn must be from the user.");
  return turns;
}

export interface AppOptions {
  runLog: RunLog;
  leads: LeadSink;
  /** Use the model for chat when credentials are present. Tests turn this off. */
  useModel?: boolean;
  /** Read the client address from X-Forwarded-For (set when running behind Azure ingress). */
  trustProxy?: boolean;
}

export function createApp({ runLog, leads, useModel = modelConfigured(), trustProxy = false }: AppOptions): Server {
  const toolLimiter = new RateLimiter(60, 60_000);
  const chatLimiter = new RateLimiter(20, 60_000);
  const leadLimiter = new RateLimiter(5, 60_000);

  const record = (run: RunRecord) => {
    runLog.append(run);
    return run;
  };

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/api/health") {
      return send(res, 200, { ok: true, engineVersion: ENGINE_VERSION, chat: useModel ? "model" : "rules" });
    }

    if (method === "GET" && path === "/api/tools") {
      return send(res, 200, {
        tools: Object.values(TOOLS).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })),
      });
    }

    const toolMatch = path.match(/^\/api\/tools\/([a-z_]+)$/);
    if (method === "POST" && toolMatch) {
      if (!toolLimiter.allow(clientKey(req, trustProxy))) throw new HttpError(429, "Too many requests. Try again in a minute.");
      const name = toolMatch[1]!;
      if (!isToolName(name)) throw new HttpError(404, `No tool named ${name}.`);
      const run = record(runTool(name, await readJson(req), { tenant: TENANT }));
      return send(res, 200, { receipt: run });
    }

    if (method === "POST" && path === "/api/chat") {
      if (!chatLimiter.allow(clientKey(req, trustProxy))) throw new HttpError(429, "Too many messages. Try again in a minute.");
      const history = parseHistory(await readJson(req));
      let reply: ChatReply;
      if (useModel) {
        try {
          reply = await modelChat(history, TENANT);
        } catch (err) {
          console.error("model chat failed; falling back to rules", err);
          reply = routeMessage(history.at(-1)!.content, TENANT);
        }
      } else {
        reply = routeMessage(history.at(-1)!.content, TENANT);
      }
      reply.runs.forEach(record);
      return send(res, 200, {
        reply: reply.reply,
        mode: reply.mode,
        openTool: reply.openTool,
        demo: reply.demo,
        signup: reply.signup,
        suggestions: reply.suggestions,
        receipts: reply.runs,
      });
    }

    if (method === "POST" && path === "/api/leads") {
      if (!leadLimiter.allow(clientKey(req, trustProxy))) throw new HttpError(429, "Too many sign-ups from here. Try again in a minute.");
      const lead = leads.add(await readJson(req));
      return send(res, 200, { ok: true, leadId: lead.leadId });
    }

    if (method === "POST" && path === "/api/replay") {
      if (!toolLimiter.allow(clientKey(req, trustProxy))) throw new HttpError(429, "Too many requests. Try again in a minute.");
      const receipt = (await readJson(req) as { receipt?: RunRecord }).receipt;
      if (!receipt || typeof receipt.runId !== "string") throw new HttpError(400, "Send the receipt from a previous result.");
      const stored = runLog.get(receipt.runId);
      if (!stored) throw new HttpError(404, "Penny has no record of that run.");
      if (stored.inputHash !== receipt.inputHash || stored.outputHash !== receipt.outputHash || stored.fingerprint !== receipt.fingerprint) {
        throw new HttpError(409, "This receipt does not match Penny's record of the run.");
      }
      return send(res, 200, replayRun(receipt));
    }

    const runMatch = path.match(/^\/api\/runs\/([0-9a-f-]{36})$/);
    if (method === "GET" && runMatch) {
      const stored = runLog.get(runMatch[1]!);
      if (!stored) throw new HttpError(404, "Penny has no record of that run.");
      return send(res, 200, { run: stored });
    }

    throw new HttpError(404, "Not found.");
  }

  async function serveStatic(res: ServerResponse, path: string) {
    const rel = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, "Not found.");
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=300",
        ...SECURITY_HEADERS,
      });
      res.end(body);
    } catch {
      throw new HttpError(404, "Not found.");
    }
  }

  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      if (path.startsWith("/api/")) await handleApi(req, res, path);
      else if (req.method === "GET" || req.method === "HEAD") await serveStatic(res, path);
      else throw new HttpError(405, "Method not allowed.");
    } catch (err) {
      if (err instanceof InputError) return send(res, 400, { error: err.message, field: err.field });
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: "Something went wrong on Penny's side." });
    }
  });
}
