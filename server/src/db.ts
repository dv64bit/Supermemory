import { SQL } from "bun";
import { readdirSync } from "node:fs";

export const sql = new SQL(process.env.DATABASE_URL ?? "postgres://localhost/supermem");

export const toVector = (v: number[]) => `[${v.join(",")}]`;

// Numbered migrations: src/migrations/<NNNN>_<name>.up.sql, each with a matching .down.sql (rollback is for
// development). Applied ones are recorded in schema_migrations with a content hash, so editing an applied
// migration is an error: add a new one instead.
const DIR = `${import.meta.dir}/migrations`;
type Migration = { version: number; name: string; up: string; down: string };

function migrations(): Migration[] {
  return readdirSync(DIR).filter((f) => f.endsWith(".up.sql")).sort().map((f) => {
    const [, version, name] = f.match(/^(\d+)_(.+)\.up\.sql$/)!;
    return { version: Number(version), name, up: `${DIR}/${f}`, down: `${DIR}/${f.replace(/\.up\.sql$/, ".down.sql")}` };
  });
}
const checksum = async (path: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(path).text()).digest("hex").slice(0, 16);
// Serialises concurrent runners (two servers, or tests sharing a database) for the length of one transaction.
const LOCK = 6767_0001;

async function applied() {
  await sql`create table if not exists schema_migrations (
    version int primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())`;
  return (await sql`select version, name, checksum from schema_migrations order by version`) as { version: number; name: string; checksum: string }[];
}

/** Applies pending migrations in order, each in its own transaction. `to` stops after that version. */
export async function migrate(opts: { to?: number } = {}) {
  const done = new Map((await applied()).map((r) => [r.version, r]));
  const ran: string[] = [];
  for (const m of migrations()) {
    if (opts.to !== undefined && m.version > opts.to) break;
    const sum = await checksum(m.up);
    const prev = done.get(m.version);
    if (prev) {
      if (prev.checksum !== sum) throw new Error(`migration ${m.version}_${m.name} was edited after it was applied; add a new migration instead`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK})`;
      const [again] = await tx`select 1 from schema_migrations where version = ${m.version}`;
      if (again) return; // another runner applied it while we waited
      await tx.unsafe(await Bun.file(m.up).text());
      await tx`insert into schema_migrations (version, name, checksum) values (${m.version}, ${m.name}, ${sum})`;
    });
    ran.push(`${m.version}_${m.name}`);
  }
  return ran;
}

/** Development only: undoes the last `steps` applied migrations, newest first. */
export async function rollback(steps = 1) {
  const all = new Map(migrations().map((m) => [m.version, m]));
  const undone: string[] = [];
  for (const r of (await applied()).reverse().slice(0, steps)) {
    const m = all.get(r.version);
    if (!m) throw new Error(`no files for applied migration ${r.version}_${r.name}`);
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK})`;
      await tx.unsafe(await Bun.file(m.down).text());
      await tx`delete from schema_migrations where version = ${m.version}`;
    });
    undone.push(`${m.version}_${m.name}`);
  }
  return undone;
}

export async function migrationStatus() {
  const done = new Map((await applied()).map((r) => [r.version, r]));
  return migrations().map((m) => ({ version: m.version, name: m.name, applied: done.has(m.version) }));
}
