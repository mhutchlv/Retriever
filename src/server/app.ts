import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatBudget, fallbackNotice, type DenyReason } from "../chat/budget.ts";
import { modelChat, modelConfigured, type ChatTurn, type ModelCost } from "../chat/claude.ts";
import { routeMessage, type ChatReply } from "../chat/router.ts";
import { isToolName, replayRun, runTool, TOOLS, type RunRecord } from "../engine/engine.ts";
import { InputError } from "../engine/money.ts";
import { ENGINE_VERSION } from "../engine/version.ts";
import type { LeadSink } from "../leads/store.ts";
import { Auth, clearedCookie, readCookie, SESSION_COOKIE, sessionCookie, type SessionUser } from "../auth/auth.ts";
import { workspaceChat } from "../workspace/penny.ts";
import { computeCase, type Case } from "../workspace/model.ts";
import { coiRequestText, reportHtml, worksheetCsv } from "../workspace/exports.ts";
import { parseAction, tenantFor, verifyTimeline, WorkspaceStore } from "../workspace/store.ts";
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

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(body);
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

function withNotice(reply: ChatReply, reason: DenyReason): ChatReply {
  console.log(JSON.stringify({ event: "chat_model_denied", reason }));
  return { ...reply, reply: `${fallbackNotice(reason)}\n\n${reply.reply}` };
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
  /** Daily spend and message limits for model-answered chat. */
  budget?: ChatBudget;
  /** Signed-in accounts. Without accounts the workspace stays closed. */
  auth?: Auth;
  workspace?: WorkspaceStore;
}

export function createApp({
  runLog,
  leads,
  useModel = modelConfigured(),
  trustProxy = false,
  budget = new ChatBudget(),
  auth = new Auth([]),
  workspace = new WorkspaceStore(),
}: AppOptions): Server {
  const toolLimiter = new RateLimiter(60, 60_000);
  const chatLimiter = new RateLimiter(20, 60_000);
  const leadLimiter = new RateLimiter(5, 60_000);
  const loginLimiter = new RateLimiter(10, 60_000);
  const actionLimiter = new RateLimiter(120, 60_000);
  // Behind Azure ingress the site is HTTPS-only, so cookies are marked Secure there.
  const secureCookies = trustProxy;

  const record = (run: RunRecord) => {
    runLog.append(run);
    return run;
  };

  // Workspace totals are recomputed on every view. A run with the same fingerprint
  // is the same result, so it is logged once and its first receipt reused.
  const seenRuns = new Map<string, RunRecord>();
  const recordOnce = (runs: RunRecord[]) =>
    runs.map((r) => {
      const seen = seenRuns.get(r.fingerprint);
      if (seen) return seen;
      record(r);
      seenRuns.set(r.fingerprint, r);
      if (seenRuns.size > 20_000) seenRuns.clear();
      return r;
    });

  const sessionToken = (req: IncomingMessage) => readCookie(req.headers.cookie, SESSION_COOKIE);
  const signedIn = (req: IncomingMessage): SessionUser => {
    const user = auth.user(sessionToken(req));
    if (!user) throw new HttpError(401, "Please sign in.");
    return user;
  };
  // State-changing requests from a browser must come from this site.
  const sameOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin) return;
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      /* treated as cross-site */
    }
    if (host !== req.headers.host) throw new HttpError(403, "Cross-site request refused.");
  };

  function receiptsOf(runs: RunRecord[]) {
    return recordOnce(runs).map((r) => ({ runId: r.runId, tool: r.tool, fingerprint: r.fingerprint, dataStatus: r.dataStatus, rules: r.rules, engineVersion: r.engineVersion }));
  }

  function caseView(user: SessionUser, c: Case) {
    const totals = computeCase(c, tenantFor(user.username));
    return { case: c, totals: { ...totals, runs: receiptsOf(totals.runs) }, timelineCheck: verifyTimeline(c) };
  }

  function caseSummary(user: SessionUser, c: Case) {
    const t = computeCase(c, tenantFor(user.username));
    return {
      id: c.id,
      insured: c.insured,
      state: c.state,
      period: `${c.policyEffectiveDate} to ${c.policyExpirationDate}`,
      status: c.status,
      dueDate: c.dueDate,
      auditType: c.auditType,
      openFlags: t.openFlags,
      openFindings: t.openFindings,
      premium: t.estimate?.totalAuditPremium,
      comparison: t.estimate?.comparison,
    };
  }

  async function handleWorkspace(req: IncomingMessage, res: ServerResponse, path: string, method: string) {
    if (method === "POST" && path === "/api/auth/login") {
      sameOrigin(req);
      if (!loginLimiter.allow(clientKey(req, trustProxy))) throw new HttpError(429, "Too many sign-in attempts. Try again in a minute.");
      const body = (await readJson(req)) as { username?: unknown; password?: unknown };
      if (typeof body.username !== "string" || typeof body.password !== "string" || body.password.length > 200) {
        throw new HttpError(400, "Enter a username and password.");
      }
      const result = auth.login(body.username, body.password);
      if (!result.ok) {
        console.log(JSON.stringify({ event: "login_failed", reason: result.reason }));
        throw new HttpError(
          result.reason === "locked" ? 429 : 401,
          result.reason === "locked" ? "Too many failed attempts. Try again in 15 minutes." : "That username and password don't match.",
        );
      }
      console.log(JSON.stringify({ event: "login", user: result.user.username }));
      return send(res, 200, { user: result.user }, { "Set-Cookie": sessionCookie(result.token, secureCookies) });
    }
    if (method === "POST" && path === "/api/auth/logout") {
      sameOrigin(req);
      auth.logout(sessionToken(req));
      return send(res, 200, { ok: true }, { "Set-Cookie": clearedCookie(secureCookies) });
    }
    if (method === "GET" && path === "/api/auth/me") {
      return send(res, 200, { user: signedIn(req) });
    }

    const user = signedIn(req);
    if (method !== "GET") {
      sameOrigin(req);
      if (!actionLimiter.allow(user.username)) throw new HttpError(429, "Too many changes in a minute. Slow down a little.");
    }

    if (method === "GET" && path === "/api/workspace/cases") {
      return send(res, 200, { user, cases: workspace.cases(user.username).map((c) => caseSummary(user, c)) });
    }
    if (method === "POST" && path === "/api/workspace/reset") {
      workspace.reset(user.username);
      return send(res, 200, { ok: true });
    }

    const coi = path.match(/^\/api\/workspace\/cases\/([A-Za-z0-9-]{1,30})\/coi-request\/([A-Za-z0-9]{1,20})$/);
    if (method === "GET" && coi) {
      const cc = workspace.get(user.username, coi[1]!);
      const s = cc?.subs.find((x) => x.id === coi[2]);
      if (!cc || !s) throw new HttpError(404, "No such subcontractor.");
      const cov = computeCase(cc, tenantFor(user.username)).subs[s.id]!;
      return send(res, 200, { coverage: cov, ...coiRequestText(cc, s, cov, user.displayName) });
    }

    const m = path.match(/^\/api\/workspace\/cases\/([A-Za-z0-9-]{1,30})(\/[a-z.]+)?$/);
    if (!m) throw new HttpError(404, "Not found.");
    const c = workspace.get(user.username, m[1]!);
    if (!c) throw new HttpError(404, "No such case.");
    const sub = m[2] ?? "";

    if (method === "GET" && sub === "") return send(res, 200, caseView(user, c));
    if (method === "POST" && sub === "/actions") {
      const action = parseAction(((await readJson(req)) as { action?: unknown }).action);
      const via = req.headers["x-penny-via"] === "penny" ? "penny" : "workspace";
      const event = workspace.apply(user.username, c.id, action, user.displayName, via);
      return send(res, 200, { event, ...caseView(user, workspace.get(user.username, c.id)!) });
    }
    if (method === "POST" && sub === "/preview") {
      const action = parseAction(((await readJson(req)) as { action?: unknown }).action);
      return send(res, 200, { card: workspace.preview(user.username, c.id, action, user.displayName) });
    }
    if (method === "POST" && sub === "/chat") {
      if (!chatLimiter.allow(clientKey(req, trustProxy))) throw new HttpError(429, "Too many messages. Try again in a minute.");
      const history = parseHistory(await readJson(req));
      if (!useModel) return send(res, 200, { reply: "Penny's assistant isn't connected on this server. Every workspace button still works.", cards: [] });
      const ticket = budget.begin(`user:${user.username.toLowerCase()}`);
      if (!ticket.ok) return send(res, 200, { reply: fallbackNotice(ticket.reason), cards: [] });
      const cost: ModelCost = { micros: 0, calls: 0 };
      try {
        const out = await workspaceChat(history, { user, store: workspace, caseId: c.id }, cost);
        return send(res, 200, { reply: out.reply, cards: out.cards, receipts: receiptsOf(out.runs) });
      } catch (err) {
        console.error("workspace chat failed", err);
        return send(res, 200, { reply: "Penny couldn't answer just now. Try again in a moment.", cards: [] });
      } finally {
        budget.finish(ticket.visitor, cost.micros, cost.calls);
      }
    }
    if (method === "GET" && sub === "/worksheet.csv") {
      return sendText(res, 200, "text/csv; charset=utf-8", worksheetCsv(c, computeCase(c, tenantFor(user.username))), {
        "Content-Disposition": `attachment; filename="${c.id}-worksheet.csv"`,
      });
    }
    if (method === "GET" && sub === "/report") {
      const view = caseView(user, c);
      return sendText(res, 200, "text/html; charset=utf-8", reportHtml(c, computeCase(c, tenantFor(user.username)), view.totals.runs, view.timelineCheck));
    }
    throw new HttpError(404, "Not found.");
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/api/health") {
      return send(res, 200, { ok: true, engineVersion: ENGINE_VERSION, chat: useModel ? "model" : "rules" });
    }

    if (path.startsWith("/api/auth/") || path.startsWith("/api/workspace/")) {
      return handleWorkspace(req, res, path, method);
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
      const question = history.at(-1)!.content;
      let reply: ChatReply;
      if (useModel) {
        const ticket = budget.begin(clientKey(req, trustProxy));
        if (ticket.ok) {
          const cost: ModelCost = { micros: 0, calls: 0 };
          try {
            reply = await modelChat(history, TENANT, cost);
          } catch (err) {
            console.error("model chat failed; falling back to rules", err);
            reply = routeMessage(question, TENANT);
          } finally {
            budget.finish(ticket.visitor, cost.micros, cost.calls);
          }
        } else {
          reply = withNotice(routeMessage(question, TENANT), ticket.reason);
        }
      } else {
        reply = routeMessage(question, TENANT);
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
      // Signed-in runs keep full inputs; only their own workspace can read them.
      if (stored.tenant !== TENANT) {
        const user = auth.user(sessionToken(req));
        if (!user || tenantFor(user.username) !== stored.tenant) throw new HttpError(404, "Penny has no record of that run.");
      }
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
