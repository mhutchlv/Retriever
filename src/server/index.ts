import { FileLeadSink } from "../leads/store.ts";
import { FileRunLog } from "../runlog/store.ts";
import { ChatBudget, limitsFromEnv } from "../chat/budget.ts";
import { accountsFromEnv, Auth } from "../auth/auth.ts";
import { WorkspaceStore } from "../workspace/store.ts";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const runLog = new FileRunLog(process.env.PENNY_RUNLOG ?? "data/runs.jsonl");
const leads = new FileLeadSink(process.env.PENNY_LEADS ?? "data/leads.jsonl", process.env.PENNY_LEAD_WEBHOOK);
const budget = new ChatBudget({
  limits: limitsFromEnv(),
  file: process.env.PENNY_CHAT_BUDGET ?? "data/chat-budget.json",
  salt: process.env.PENNY_VISITOR_SALT ?? process.env.HOSTNAME ?? "penny",
});
const auth = new Auth(accountsFromEnv());
const workspace = new WorkspaceStore(process.env.PENNY_WORKSPACE ?? "data/workspace.json");
const app = createApp({ runLog, leads, trustProxy: process.env.PENNY_TRUST_PROXY === "1", budget, auth, workspace });

app.listen(port, () => {
  console.log(`Penny is running at http://localhost:${port}`);
  if (!auth.enabled) console.log("No PENNY_USERS set: the workspace sign-in is closed.");
});

// Node as a container's PID 1 ignores SIGTERM unless handled; finish in-flight requests, then exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
