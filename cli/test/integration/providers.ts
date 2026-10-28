import { spawnSync } from "node:child_process";

export type Provider = "docker" | "tart" | "shuru";

export interface ProviderSuite {
	spec: string;
	/** Returns why the provider cannot run on this machine, or null when it can. */
	missing(): string | null;
}

function succeeds(command: string, args: string[]): boolean {
	return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

function output(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { encoding: "utf-8", stdio: "pipe" });
	return result.status === 0 ? (result.stdout ?? "") : null;
}

function hasTartBaseVM(): boolean {
	const list = output("tart", ["list", "--format", "json"]);
	if (list === null) return false;
	try {
		const vms = JSON.parse(list) as { Name?: string; name?: string }[];
		return vms.some((vm) => (vm.Name ?? vm.name) === "sandbox-base");
	} catch {
		return false;
	}
}

export const providers: Record<Provider, ProviderSuite> = {
	docker: {
		spec: "test/integration/e2b-smoke.spec.ts",
		missing: () =>
			succeeds("docker", ["info"]) ? null : "Docker daemon is not reachable",
	},
	tart: {
		spec: "test/integration/tart-smoke.spec.ts",
		missing: () => {
			if (!succeeds("tart", ["--version"])) return "tart CLI is not installed";
			if (!hasTartBaseVM())
				return "no tart VM named sandbox-base (see CONTRIBUTING.md)";
			return null;
		},
	},
	shuru: {
		spec: "test/integration/shuru-smoke.spec.ts",
		missing: () => {
			if (!succeeds("shuru", ["--version"]))
				return "shuru CLI is not installed";
			if (
				!(output("shuru", ["checkpoint", "list"]) ?? "").includes(
					"sandbox-base",
				)
			) {
				return "no shuru checkpoint named sandbox-base (see docs/container-runtimes.md)";
			}
			return null;
		},
	},
};
