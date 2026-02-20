export interface SandboxLabels {
  "e2b.sandbox-id": string;
  "e2b.access-token": string;
  "e2b.template-id": string;
  "e2b.created-at": string;
  "e2b.timeout": string;
  "e2b.metadata"?: string;
}

export interface SandboxInfo {
  sandboxId: string;
  containerId: string;
  accessToken: string;
  templateId: string;
  createdAt: string;
  timeoutSec: number;
  hostPort: number;
  state: "running" | "paused";
  metadata?: Record<string, string>;
}
