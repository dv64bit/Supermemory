// bun run db:migrate | db:rollback [steps] | db:status   (uses DATABASE_URL; the server also migrates on start)
import { migrate, migrationStatus, rollback, sql } from "./db";

const [cmd, arg] = process.argv.slice(2);
if (cmd === "up") {
  const ran = await migrate();
  console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
} else if (cmd === "down") {
  const undone = await rollback(Number(arg ?? 1));
  console.log(undone.length ? `rolled back: ${undone.join(", ")}` : "nothing to roll back");
} else if (cmd === "status") {
  for (const m of await migrationStatus()) console.log(`${m.applied ? "applied" : "pending"}  ${String(m.version).padStart(4, "0")}_${m.name}`);
} else {
  console.error("usage: bun src/migrate.ts up | down [steps] | status");
  process.exitCode = 1;
}
await sql.close();
