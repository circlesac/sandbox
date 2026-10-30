import { defineConfig } from "vitest/config";

// scripts/sdk-matrix.ts points the e2b import at a separately installed SDK.
const sdkEntry = process.env.E2B_SDK_ENTRY;

export default defineConfig({
	resolve: sdkEntry ? { alias: { e2b: sdkEntry } } : undefined,
	test: {
		globals: true,
		coverage: {
			include: ["src/**"],
		},
		projects: [
			{
				extends: true,
				test: { name: "unit", include: ["test/unit/**/*.spec.ts"] },
			},
			{
				extends: true,
				test: {
					name: "integration",
					include: ["test/integration/**/*.spec.ts"],
					globalSetup: ["./test/global-setup.ts"],
					// The suites share one server and one Docker daemon; running them
					// one at a time keeps sandbox start-up within envd's health timeout.
					fileParallelism: false,
				},
			},
		],
	},
});
