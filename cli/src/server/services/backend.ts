import type { SandboxInfo } from "../types.ts";
import type { SandboxLifecycle } from "./lifecycle.ts";
import { DockerService } from "./docker.ts";
import { ShuruBackend } from "./shuru.ts";
import { TartBackend } from "./tart.ts";

export type BackendType = "docker" | "shuru" | "tart";
export type Platform = "linux" | "macos";

export interface CreateContainerOpts {
	sandboxId: string;
	accessToken: string;
	templateId: string;
	timeoutSec: number;
	envVars?: Record<string, string>;
	metadata?: Record<string, string>;
	lifecycle: SandboxLifecycle;
}

/** Where to send a request for a sandbox port. */
export interface ProxyTarget {
	host: string;
	port: number;
}

export interface ContainerBackend {
	readonly type: BackendType;
	readonly supportsPause: boolean;
	/** Whether a pause can drop memory and keep only the filesystem. */
	readonly supportsFilesystemPause: boolean;
	/** Whether the sandbox's envd itself rejects requests without the access token. */
	readonly envdChecksAccessToken: boolean;
	/** Whether envd may be given the access token at /init (some builds cannot take one). */
	readonly envdAcceptsAccessToken: boolean;

	resolveImage(templateId: string): Promise<string>;

	/** Optional: start downloading a template image ahead of the first create. */
	prefetchImage?(templateId: string): void;

	createContainer(
		opts: CreateContainerOpts,
	): Promise<{ instanceId: string; hostPort: number }>;

	startContainer(sandboxId: string): Promise<{ hostPort: number }>;

	refreshTimeout?(sandboxId: string, timeoutSec: number): Promise<void> | void;

	/** Pauses a sandbox; keepMemory false keeps only the filesystem. */
	stopContainer(
		sandboxId: string,
		opts?: { keepMemory?: boolean },
	): Promise<boolean>;

	/** Optional: save a sandbox's filesystem as a template image. */
	commitTemplate?(
		sandboxId: string,
		templateId: string,
		labels: Record<string, string>,
	): Promise<void>;

	/** Optional: remove template images by reference. */
	removeTemplateImages?(refs: string[]): Promise<number>;

	/** Optional: the envd API version the sandbox runs, which the SDK gates features on. */
	envdVersion?(sandboxId: string): Promise<string | null>;

	/** Optional: environment variables the sandbox's image defines. */
	imageEnv?(sandboxId: string): Promise<Record<string, string>>;

	/** Optional: run a built template's start command and wait until it is ready. */
	runTemplateStart?(sandboxId: string): Promise<void>;

	/** Resolves a port inside a running sandbox to an address the server can reach. */
	resolveTarget(sandboxId: string, port: number): Promise<ProxyTarget | null>;

	removeContainer(sandboxId: string): Promise<boolean>;

	inspectSandbox(sandboxId: string): Promise<SandboxInfo | null>;

	listSandboxes(filters?: {
		state?: "running" | "paused";
	}): Promise<SandboxInfo[]>;
}

export function createBackend(
	type: BackendType,
	opts: { dockerSocket?: string },
): ContainerBackend {
	switch (type) {
		case "docker":
			return new DockerService({
				socketPath: opts.dockerSocket ?? "/var/run/docker.sock",
			});
		case "shuru":
			return new ShuruBackend();
		case "tart":
			return new TartBackend();
		default:
			throw new Error(`Unknown backend: ${type satisfies never}`);
	}
}

/** Map of platform → backend. Linux is required, macOS is optional. */
export interface BackendMap {
	linux: ContainerBackend;
	macos?: ContainerBackend;
}

export function createBackends(opts: {
	linux: BackendType;
	macos?: BackendType;
	dockerSocket?: string;
}): BackendMap {
	let macos = opts.macos;

	if (macos === "tart" && !TartBackend.isAvailable()) {
		macos = undefined;
	}

	return {
		linux: createBackend(opts.linux, { dockerSocket: opts.dockerSocket }),
		macos: macos
			? createBackend(macos, { dockerSocket: opts.dockerSocket })
			: undefined,
	};
}

export function resolvePlatform(metadata?: Record<string, string>): Platform {
	return metadata?.platform === "macos" ? "macos" : "linux";
}
