import { nanoid } from "nanoid";

export function generateSandboxId(): string {
  return `sbx-${nanoid(12)}`;
}

export function generateAccessToken(): string {
  return nanoid(32);
}
