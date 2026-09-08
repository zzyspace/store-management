import path from "node:path";
import { createRepository } from "./repository.js";
import { createApp } from "./app.js";

const port = Number(process.env.STORE_PORT ?? 8791);
const host = process.env.STORE_HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid STORE_PORT.");
if (!["127.0.0.1", "::1"].includes(host)) throw new Error("STORE_HOST must be loopback.");
const repository = createRepository({ stateDir: path.resolve(process.env.STORE_STATE_DIR ?? "data") });
const app = createApp({ repository });
const server = app.listen(port, host, () => console.log(`store-management listening on ${host}:${port}`));
server.on("error", (error) => { console.error(error.code); repository.close(); process.exitCode = 1; });
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close(() => { repository.close(); process.exit(0); }));
