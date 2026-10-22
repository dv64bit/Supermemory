import { SQL } from "bun";

export const sql = new SQL(process.env.DATABASE_URL ?? "postgres://localhost/supermem");

export async function migrate() {
  await sql.file(`${import.meta.dir}/schema.sql`);
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;
