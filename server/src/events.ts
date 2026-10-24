// memory_events: the audit trail. One row per change to a memory, written in the same transaction as the change.
import type { SQL } from "bun";
import { sql as db } from "./db";

export type Action =
  | "create" | "update" | "supersede" | "extend" | "derive" | "strengthen" | "decay" | "expire"
  | "forget" | "restore" | "approve" | "reject" | "edit";
export type Actor = "dreamer" | "api" | "sweeper" | "user";
export type MemoryEvent = {
  memoryPk: number; action: Action; actor: Actor; reason?: string | null;
  before?: Record<string, unknown> | null; after?: Record<string, unknown> | null;
  pipelineVersion?: string | null; dreamRunId?: string | null;
};

export async function logEvents(events: MemoryEvent[], tx: SQL = db) {
  for (const e of events) {
    await tx`insert into memory_events (memory_pk, action, actor, reason, before, after, pipeline_version, dream_run_id)
      values (${e.memoryPk}, ${e.action}, ${e.actor}, ${e.reason ?? null}, ${e.before ?? null}, ${e.after ?? null},
              ${e.pipelineVersion ?? null}, ${e.dreamRunId ?? null})`;
  }
}
