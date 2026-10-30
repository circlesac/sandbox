import { createHash, timingSafeEqual } from "node:crypto";
import { UnsupportedError } from "../errors.ts";
import { generateAccessToken } from "../lib/id.ts";

/** How a sandbox behaves over time and how its traffic is admitted; fixed at creation. */
export interface SandboxLifecycle {
	/** On timeout, pause (true) or kill (false). E2B kills by default. */
	autoPause: boolean;
	/** Whether a pause keeps memory and running processes, or only the filesystem. */
	keepMemory: boolean;
	/** Whether traffic to a paused sandbox resumes it. */
	autoResume: boolean;
	/** Whether envd requests must carry the sandbox's access token. */
	secure: boolean;
	/** Token required on requests to sandbox ports other than envd; null when public. */
	trafficAccessToken: string | null;
}

/**
 * Sandboxes created before lifecycles were recorded paused on timeout by
 * stopping the container, required the access token, and did not resume on
 * traffic. Keep that behavior for them.
 */
export const LEGACY_LIFECYCLE: SandboxLifecycle = {
	autoPause: true,
	keepMemory: false,
	autoResume: false,
	secure: true,
	trafficAccessToken: null,
};

/** The capabilities a backend declares, used to reject options it cannot honor. */
export interface LifecycleCapabilities {
	type: string;
	supportsPause: boolean;
	/** Whether a pause can drop memory and keep only the filesystem. */
	supportsFilesystemPause: boolean;
}

/** The E2B NewSandbox / NewSandboxV2 fields that are not plain data. */
export interface CreateOptions {
	autoPause?: boolean;
	autoPauseMemory?: boolean;
	autoResume?: boolean | { enabled?: boolean };
	secure?: boolean;
	allow_internet_access?: boolean;
	network?: Record<string, unknown> | null;
	mcp?: Record<string, unknown> | null;
	iam?: Record<string, unknown> | null;
	volumeMounts?: unknown[] | null;
}

/**
 * Turns the create options into a lifecycle, or rejects the request when it
 * asks for something this server or the backend cannot do. Nothing the
 * client set is silently dropped.
 */
export function lifecycleFromCreate(
	req: CreateOptions,
	backend: LifecycleCapabilities,
): SandboxLifecycle {
	const unsupported: string[] = [];

	if (req.allow_internet_access === false) {
		unsupported.push("allow_internet_access: false (blocking internet access)");
	}
	const { allowPublicTraffic, ...network } = req.network ?? {};
	for (const [key, value] of Object.entries(network)) {
		if (value !== undefined && value !== null)
			unsupported.push(`network.${key}`);
	}
	if (req.mcp && Object.keys(req.mcp).length > 0) unsupported.push("mcp");
	if (req.iam && Object.keys(req.iam).length > 0) unsupported.push("iam");
	if (req.volumeMounts && req.volumeMounts.length > 0) {
		unsupported.push("volumeMounts");
	}

	const autoPause = req.autoPause === true;
	const keepMemory = req.autoPauseMemory !== false;
	const autoResume =
		typeof req.autoResume === "boolean"
			? req.autoResume
			: req.autoResume?.enabled === true;

	if (autoPause && !backend.supportsPause) {
		unsupported.push(`autoPause on the ${backend.type} backend`);
	}
	if (autoPause && !keepMemory && !backend.supportsFilesystemPause) {
		unsupported.push(`autoPauseMemory: false on the ${backend.type} backend`);
	}
	if (unsupported.length > 0) {
		throw new UnsupportedError(
			`Unsupported sandbox options: ${unsupported.join(", ")}`,
		);
	}
	if (req.autoPauseMemory === false && !autoPause) {
		throw new UnsupportedError("autoPauseMemory requires autoPause");
	}
	if (autoResume && !autoPause) {
		throw new UnsupportedError("autoResume requires autoPause");
	}
	if (autoResume && !keepMemory) {
		throw new UnsupportedError(
			"autoResume requires a pause that keeps memory (autoPauseMemory must not be false)",
		);
	}

	return {
		autoPause,
		keepMemory,
		autoResume,
		// E2B secures every sandbox and ignores `secure: false` from v1 clients.
		secure: true,
		trafficAccessToken:
			allowPublicTraffic === false ? generateAccessToken() : null,
	};
}

/**
 * Checks an E2B signed file URL: `v1_` + unpadded base64 SHA-256 of
 * `path:operation:user:token[:expiration]`, as the E2B SDK's getSignature
 * builds it.
 */
export function verifyFileSignature(opts: {
	signature: string;
	path: string;
	operation: "read" | "write";
	user: string;
	accessToken: string;
	expiration: string | null;
	nowSec?: number;
}): boolean {
	if (opts.expiration !== null) {
		const expiresAt = Number(opts.expiration);
		const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
		if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
	}
	const raw = [opts.path, opts.operation, opts.user, opts.accessToken];
	if (opts.expiration !== null) raw.push(opts.expiration);
	const expected = `v1_${createHash("sha256").update(raw.join(":")).digest("base64").replace(/=+$/, "")}`;
	const a = Buffer.from(expected);
	const b = Buffer.from(opts.signature);
	return a.length === b.length && timingSafeEqual(a, b);
}
