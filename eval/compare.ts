// bun run eval:compare [runA] [runB]
//   two args: compare those runs (id, file name, or path)
//   one arg : a layer-name like "e2-retrieval": its last two runs
//   no args : the last two runs of every layer-name that has at least two
import { readdirSync } from "node:fs";
import { ROOT, type Run } from "./lib";

const dirs = [`${ROOT}/eval/runs`, `${ROOT}/eval/private/runs`];
const all: (Run & { file: string })[] = [];
for (const d of dirs) {
  let files: string[] = [];
  try { files = readdirSync(d).filter((f) => f.endsWith(".json")); } catch { continue; }
  for (const f of files) all.push({ ...(await Bun.file(`${d}/${f}`).json()), file: `${d}/${f}` });
}
all.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const find = (ref: string) => all.find((r) => r.id === ref || r.file.endsWith(ref) || r.file.endsWith(`${ref}.json`)) ?? die(`no run ${ref}`);
function die(msg: string): never { console.error(msg); process.exit(1); }

const fmt = (v: number | undefined) => (v === undefined ? "-" : Number.isInteger(v) ? String(v) : v.toFixed(3));
function diff(label: string, a: Record<string, number>, b: Record<string, number>) {
  const rows = [...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => {
    const d = a[k] !== undefined && b[k] !== undefined ? b[k] - a[k] : undefined;
    return `| ${label}${k} | ${fmt(a[k])} | ${fmt(b[k])} | ${d === undefined ? "" : (d > 0 ? "+" : "") + fmt(d)} |`;
  });
  return rows;
}

function compare(a: Run, b: Run) {
  const out = [
    `## ${b.layer}/${b.name}: ${a.id} (${a.git.sha}) -> ${b.id} (${b.git.sha}${b.git.dirty ? "+dirty" : ""})`,
    "",
    "| metric | A | B | delta |",
    "|---|---|---|---|",
    ...diff("", a.metrics, b.metrics),
  ];
  for (const g of new Set([...Object.keys(a.groups ?? {}), ...Object.keys(b.groups ?? {})])) {
    out.push(...diff(`${g}.`, a.groups?.[g] ?? {}, b.groups?.[g] ?? {}));
  }
  const cfgA = JSON.stringify(a.config), cfgB = JSON.stringify(b.config);
  if (cfgA !== cfgB) out.push("", `Config differs: A=${cfgA} B=${cfgB}`);
  console.log(out.join("\n") + "\n");
}

const args = process.argv.slice(2);
if (args.length === 2) compare(find(args[0]), find(args[1]));
else {
  const groups = new Map<string, Run[]>();
  for (const r of all) groups.set(`${r.layer}-${r.name}`, [...(groups.get(`${r.layer}-${r.name}`) ?? []), r]);
  const keys = args.length === 1 ? [args[0]] : [...groups.keys()];
  let shown = 0;
  for (const k of keys) {
    const runs = groups.get(k) ?? [];
    if (runs.length >= 2) (compare(runs.at(-2)!, runs.at(-1)!), shown++);
    else if (args.length === 1) die(`need two runs of ${k}, found ${runs.length}`);
  }
  if (!shown) console.log("Nothing to compare yet: each layer needs at least two runs.");
}
