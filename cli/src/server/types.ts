import type { SandboxLifecycle } from "./services/lifecycle.ts";

export interface SandboxLabels {
	"e2b.sandbox-id": string;
	"e2b.access-token": string;
	"e2b.template-id": string;
	"e2b.created-at": string;
	"e2b.timeout": string;
	"e2b.metadata"?: string;
	"e2b.lifecycle"?: string;
}

export interface SandboxInfo {
	sandboxId: string;
	instanceId: string;
	accessToken: string;
	templateId: string;
	/** When the sandbox was created; fixed for its life. */
	startedAt: string;
	/** Where its current timeout counts from: creation, or the last extension. */
	timeoutFrom: string;
	timeoutSec: number;
	hostPort: number;
	state: "running" | "paused";
	metadata?: Record<string, string>;
	lifecycle: SandboxLifecycle;
}
