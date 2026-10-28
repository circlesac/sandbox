import { defineConfig } from "vitest/config";

// scripts/sdk-matrix.ts points the e2b import at a separately installed SDK.
const sdkEntry = process.env.E2B_SDK_ENTRY;

export default defineConfig({
	resolve: sdkEntry ? { alias: { e2b: sdkEntry } } : undefined,
	test: {
		include: ["**/*.spec.ts"],
		exclude: ["node_modules", "dist"],
		globals: true,
		globalSetup: ["./test/global-setup.ts"],
		coverage: {
			include: ["src/**"],
		},
	},
});
