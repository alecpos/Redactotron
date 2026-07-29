import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const python = resolve(root, ".venv/bin/python");
const nextCli = resolve(root, "node_modules/next/dist/bin/next");

if (!existsSync(python)) {
  console.error(
    "Python environment missing. Run: python3 -m venv .venv && " +
      ".venv/bin/pip install -r requirements.txt",
  );
  process.exit(1);
}

const children = [
  spawn(process.execPath, [nextCli, "dev"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  }),
  spawn(
    python,
    ["-m", "flask", "--app", "api.redact:app", "run", "--port", "5328"],
    {
      cwd: root,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: "inherit",
    },
  ),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!stopping) {
      stop();
      process.exitCode = code ?? (signal ? 1 : 0);
    }
  });
}
