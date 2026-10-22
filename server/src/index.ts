import { createApp } from "./app";
import { migrate } from "./db";
import { startWorker } from "./worker";

const apiKey = process.env.SUPERMEM_API_KEY;
if (!apiKey) throw new Error("SUPERMEM_API_KEY is required");

await migrate();
startWorker();

const port = Number(process.env.PORT ?? 6767);
Bun.serve({ port, hostname: process.env.HOST ?? "127.0.0.1", fetch: createApp(apiKey).fetch });
console.log(`supermem listening on http://${process.env.HOST ?? "127.0.0.1"}:${port}`);
