import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`sqlx-js prepare: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync("dist/bin/sqlx-js.js")) run("bun", ["run", "build"]);

const lefthook = "node_modules/lefthook/bin/index.js";
if (existsSync(".git") && existsSync(lefthook)) {
  spawnSync(process.execPath, [lefthook, "install"], { stdio: "ignore" });
}
