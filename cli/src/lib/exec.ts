import { spawnSync } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function exec(cmd: string): ExecResult {
  const result = spawnSync(cmd, { shell: true, encoding: "utf-8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

export function execInteractive(cmd: string) {
  const result = spawnSync(cmd, { shell: true, stdio: "inherit" });
  return result.status ?? 1;
}

export function commandExists(name: string) {
  const { exitCode } = exec(`command -v ${name}`);
  return exitCode === 0;
}
