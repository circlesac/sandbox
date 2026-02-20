import { commandExists, exec } from "./exec.ts";

export function isDockerInstalled() {
  return commandExists("docker");
}

export function isDockerRunning() {
  const { exitCode } = exec("docker info");
  return exitCode === 0;
}
