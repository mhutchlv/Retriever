import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunRecord } from "../engine/engine.ts";

/**
 * "hashes-only": keep the fingerprint and hashes, never the inputs or outputs.
 *   Used for the no-login free tools, which promise not to retain what people enter.
 *   The user holds the full record as a receipt; the stored hashes prove it is genuine.
 * "full": keep the whole record (signed-in and carrier tenants, under their data terms).
 */
export type Retention = "hashes-only" | "full";

export type StoredRun = Omit<RunRecord, "input" | "output"> & {
  retention: Retention;
  input?: RunRecord["input"];
  output?: unknown;
};

export function retentionFor(tenant: string): Retention {
  return tenant === "public" ? "hashes-only" : "full";
}

export function toStored(record: RunRecord): StoredRun {
  const retention = retentionFor(record.tenant);
  if (retention === "full") return { ...record, retention };
  const { input: _input, output: _output, ...hashes } = record;
  return { ...hashes, retention };
}

export interface RunLog {
  append(record: RunRecord): StoredRun;
  get(runId: string): StoredRun | undefined;
}

export class MemoryRunLog implements RunLog {
  protected readonly runs = new Map<string, StoredRun>();

  append(record: RunRecord): StoredRun {
    const stored = toStored(record);
    this.runs.set(stored.runId, stored);
    return stored;
  }

  get(runId: string): StoredRun | undefined {
    return this.runs.get(runId);
  }
}

/** Append-only JSON Lines file. Fine for phase 1; swap for a database behind the same interface. */
export class FileRunLog extends MemoryRunLog {
  private readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const stored = JSON.parse(line) as StoredRun;
        this.runs.set(stored.runId, stored);
      }
    }
  }

  override append(record: RunRecord): StoredRun {
    const stored = super.append(record);
    appendFileSync(this.path, JSON.stringify(stored) + "\n");
    return stored;
  }
}
