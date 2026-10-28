import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	NotFoundError,
	UnsupportedError,
} from "../../../../src/server/errors.ts";
import type { DockerService } from "../../../../src/server/services/docker.ts";
import { TemplateService } from "../../../../src/server/services/templates.ts";

/** A Docker stand-in that records the build context it was given. */
function fakeDocker(buildResult: () => void = () => {}) {
	const built: { dockerfile: string; files: string[]; templateId: string }[] =
		[];
	const docker = {
		resolveImage: vi.fn(async () => "ghcr.io/circlesac/sandbox-base:latest"),
		buildTemplate: vi.fn(
			async (
				dir: string,
				entries: string[],
				templateId: string,
				opts: { onLog: (line: string, isError: boolean) => void },
			) => {
				built.push({
					dockerfile: readFileSync(join(dir, "Dockerfile"), "utf-8"),
					files: entries,
					templateId,
				});
				opts.onLog("Step 1/1 : FROM x", false);
				buildResult();
			},
		),
	};
	return { docker: docker as unknown as DockerService, built };
}

async function waitForStatus(
	service: TemplateService,
	id: string,
	build: string,
) {
	await vi.waitFor(() => {
		const { status } = service.status(id, build);
		if (status === "building" || status === "waiting") throw new Error(status);
	});
	return service.status(id, build);
}

describe("TemplateService", () => {
	let filesDir: string;

	beforeEach(() => {
		filesDir = mkdtempSync(join(tmpdir(), "template-files-"));
	});

	it("rejects a name Docker cannot use", () => {
		const { docker } = fakeDocker();
		expect(() =>
			new TemplateService(docker, filesDir).requestBuild({ name: "My App" }),
		).toThrow(UnsupportedError);
	});

	it("turns E2B steps into a Dockerfile on top of a template", async () => {
		const { docker, built } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "app" });

		await service.startBuild(templateID, buildID, {
			fromTemplate: "base",
			steps: [
				{ type: "RUN", args: ["apt-get update"] },
				{ type: "RUN", args: ["whoami > /tmp/who", "user"] },
				{ type: "ENV", args: ["A", "1", "B", "two words"] },
				{ type: "WORKDIR", args: ["/home/user/app"] },
				{ type: "USER", args: ["user"] },
				{ type: "RUN", args: ["echo as user"] },
			],
			startCmd: "npm start",
			readyCmd: "curl -sf localhost:3000",
		});
		const status = await waitForStatus(service, templateID, buildID);

		expect(status.status).toBe("ready");
		expect(built[0]?.dockerfile.split("\n")).toEqual([
			"FROM sandbox-base:latest",
			"RUN apt-get update",
			"USER user",
			"RUN whoami > /tmp/who",
			"USER root",
			'ENV A="1" B="two words"',
			"WORKDIR /home/user/app",
			"USER user",
			"RUN echo as user",
			"USER root",
			'LABEL e2b.start-cmd="npm start"',
			'LABEL e2b.ready-cmd="curl -sf localhost:3000"',
			"ENTRYPOINT []",
			'CMD ["/usr/bin/envd", "-isnotfc"]',
			"",
		]);
		expect(status.logEntries.map((e) => e.message)).toContain(
			"Step 1/1 : FROM x",
		);
	});

	it("adds envd and the default user to a plain image", async () => {
		const { docker, built } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "plain" });
		await service.startBuild(templateID, buildID, {
			fromImage: "debian:bookworm-slim",
		});
		await waitForStatus(service, templateID, buildID);

		const lines = built[0]?.dockerfile.split("\n") ?? [];
		expect(lines.slice(0, 2)).toEqual([
			"FROM debian:bookworm-slim",
			"COPY --from=ghcr.io/circlesac/sandbox-base:latest /usr/bin/envd /usr/bin/envd",
		]);
		expect(lines.some((l) => l.includes("useradd -m -s /bin/bash user"))).toBe(
			true,
		);
	});

	it("copies an uploaded archive and applies owner and mode", async () => {
		const src = mkdtempSync(join(tmpdir(), "template-src-"));
		mkdirSync(join(src, "app"));
		writeFileSync(join(src, "app", "main.py"), "print(1)");
		const archive = join(tmpdir(), `upload-${Date.now()}.tar`);
		spawnSync("tar", ["-czf", archive, "-C", src, "app"]);

		const { docker, built } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "copy" });
		const link = service.fileUploadLink("h1", "http://localhost:49982");
		expect(link.present).toBe(false);
		const token =
			new URL(link.url ?? "").searchParams.get("token") ?? undefined;
		await service.storeUpload(
			"h1",
			token,
			new Uint8Array(readFileSync(archive)).buffer,
		);
		expect(service.fileUploadLink("h1", "http://localhost:49982").present).toBe(
			true,
		);

		await service.startBuild(templateID, buildID, {
			fromTemplate: "base",
			steps: [
				{
					type: "COPY",
					args: ["app", "/home/user/app", "user", "0755"],
					filesHash: "h1",
				},
			],
		});
		await waitForStatus(service, templateID, buildID);

		expect(built[0]?.files).toEqual(["Dockerfile", "files"]);
		expect(built[0]?.dockerfile).toContain(
			'COPY --chown=user ["files/h1/app","/home/user/app"]',
		);
		expect(built[0]?.dockerfile).toContain('RUN chmod 0755 "/home/user/app"');
	});

	it("rejects an upload with the wrong token", async () => {
		const { docker } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		await expect(
			service.storeUpload("h1", "guess", new ArrayBuffer(1)),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it.each([
		[
			{ fromTemplate: "base", fromImageRegistry: { type: "aws" } },
			/fromImageRegistry/,
		],
		[{ steps: [] }, /fromImage or fromTemplate/],
		[
			{ fromTemplate: "base", steps: [{ type: "ARG", args: ["X"] }] },
			/unknown step type ARG/,
		],
		[
			{
				fromTemplate: "base",
				steps: [{ type: "COPY", args: ["a", "/a"], filesHash: "missing" }],
			},
			/files for a were not uploaded/,
		],
	])("refuses to start a build that cannot work: %j", async (body, error) => {
		const { docker } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "bad" });
		await expect(service.startBuild(templateID, buildID, body)).rejects.toThrow(
			error,
		);
	});

	it("reports a failed build with its reason and log offsets", async () => {
		const { docker } = fakeDocker(() => {
			throw new Error(
				"The command '/bin/sh -c exit 7' returned a non-zero code: 7",
			);
		});
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "fails" });
		await service.startBuild(templateID, buildID, { fromTemplate: "base" });
		const status = await waitForStatus(service, templateID, buildID);

		expect(status.status).toBe("error");
		expect(status.reason?.message).toMatch(/non-zero code: 7/);
		const total = status.logEntries.length;
		expect(service.status(templateID, buildID, total).logEntries).toEqual([]);
	});

	it("does not know builds of another template", () => {
		const { docker } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { buildID } = service.requestBuild({ name: "one" });
		expect(() => service.status("two", buildID)).toThrow(NotFoundError);
	});
});
