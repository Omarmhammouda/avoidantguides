// Runs during `wrangler deploy` (see "build.command" in wrangler.jsonc).
// In Cloudflare Workers Builds, secrets saved under the BUILD section arrive
// here as environment variables — this script relays them into the Worker's
// RUNTIME secrets, so pasting a key in either dashboard section works.
// Values are piped straight through; nothing is ever printed.
import { spawnSync } from "node:child_process";

const NAMES = ["ANTHROPIC_API_KEY", "COMPASS_PASSWORD"];

for (const name of NAMES) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.log(`[sync-secrets] ${name}: not in build env, skipping`);
    continue;
  }
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
    env: process.env,
  });
  console.log(
    `[sync-secrets] ${name}: ${result.status === 0 ? "synced to runtime secrets" : "SYNC FAILED"}`,
  );
}
