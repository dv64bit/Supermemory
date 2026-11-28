import { createApp } from "./app";
import { migrate } from "./db";
import { startWorker } from "./worker";

const apiKey = process.env.SUPERMEM_API_KEY;
if (!apiKey) throw new Error("SUPERMEM_API_KEY is required");

await migrate();
startWorker();

const port = Number(process.env.PORT ?? 6767);
// idleTimeout: Bun closes a connection that is quiet for 10 s by default; chat waiting on a cold local model is
// quiet longer than that (it also pings every 5 s). 255 s is Bun's maximum.
Bun.serve({ port, hostname: process.env.HOST ?? "127.0.0.1", idleTimeout: 255, fetch: createApp(apiKey).fetch });
console.log(`supermem listening on http://${process.env.HOST ?? "127.0.0.1"}:${port}`);
