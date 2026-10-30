import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
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
		// A snapshot named "snap" exists as its default tag, as Docker resolves it.
		resolveImage: vi.fn(async (templateId: string) =>
			templateId === "snap"
				? "sandbox-snap:default"
				: "ghcr.io/circlesac/sandbox-base:latest",
		),
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
		tagTemplate: vi.fn(async () => "sha256:deadbeef"),
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
				{ type: "RUN", args: ["cat > /tmp/x <<EOF\nhello\nEOF"] },
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
			"FROM ghcr.io/circlesac/sandbox-base:latest",
			'RUN ["/bin/sh","-c","apt-get update"]',
			"USER user",
			'RUN ["/bin/sh","-c","whoami > /tmp/who"]',
			"USER root",
			// A multi-line command stays one instruction.
			'RUN ["/bin/sh","-c","cat > /tmp/x <<EOF\\nhello\\nEOF"]',
			'ENV A="1" B="two words"',
			"WORKDIR /home/user/app",
			"USER user",
			'RUN ["/bin/sh","-c","echo as user"]',
			"USER root",
			'LABEL e2b.start-cmd="npm start"',
			'LABEL e2b.ready-cmd="curl -sf localhost:3000"',
			"ENTRYPOINT []",
			'CMD ["/bin/sh", "-c", "if [ -x /usr/local/bin/sandbox-portf ]; then /usr/local/bin/sandbox-portf & fi; exec /usr/bin/envd -isnotfc"]',
			"",
		]);
		expect(status.logEntries.map((e) => e.message)).toContain(
			"Step 1/1 : FROM x",
		);
	});

	it("builds on a snapshot by its bare name, as Sandbox.create resolves it", async () => {
		const { docker, built } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "onsnap" });
		await service.startBuild(templateID, buildID, { fromTemplate: "snap" });
		await waitForStatus(service, templateID, buildID);
		expect(built[0]?.dockerfile.split("\n")[0]).toBe(
			"FROM sandbox-snap:default",
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
		expect(built[0]?.dockerfile).toContain(
			'RUN ["chmod","0755","/home/user/app"]',
		);
	});

	it("accepts an upload URL's token for its own file hash only", async () => {
		const { docker } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const link = service.fileUploadLink("h1", "http://localhost:49982");
		const token =
			new URL(link.url ?? "").searchParams.get("token") ?? undefined;
		await expect(
			service.storeUpload("h2", token, new ArrayBuffer(1)),
		).rejects.toBeInstanceOf(NotFoundError);
		await service.storeUpload("h1", token, new ArrayBuffer(1));
		expect(() =>
			service.fileUploadLink("../../etc", "http://localhost:49982"),
		).toThrow(UnsupportedError);
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
		[
			{
				fromTemplate: "base",
				steps: [{ type: "WORKDIR", args: ["/a\nRUN x"] }],
			},
			/WORKDIR must not contain a line break/,
		],
		[
			{ fromTemplate: "base", steps: [{ type: "ENV", args: ["A B", "1"] }] },
			/invalid environment variable name "A B"/,
		],
	])("refuses to start a build that cannot work: %j", async (body, error) => {
		const { docker } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "bad" });
		await expect(service.startBuild(templateID, buildID, body)).rejects.toThrow(
			error,
		);
	});

	it("marks a build that cannot start as failed and leaves no temp directory", async () => {
		const { docker } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "early" });
		const before = readdirSync(tmpdir()).filter((f) =>
			f.startsWith("sandbox-template-"),
		);
		await expect(
			service.startBuild(templateID, buildID, {
				fromTemplate: "base",
				steps: [{ type: "ENV", args: ["A B", "1"] }],
			}),
		).rejects.toThrow(/invalid environment variable name/);
		const after = readdirSync(tmpdir()).filter((f) =>
			f.startsWith("sandbox-template-"),
		);
		expect(after.filter((f) => !before.includes(f))).toEqual([]);
		const status = service.status(templateID, buildID);
		expect(status.status).toBe("error");
		expect(status.reason?.message).toMatch(/invalid environment variable name/);
	});

	it("marks a build with an unsupported registry as failed", async () => {
		const { docker } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "reg" });
		await expect(
			service.startBuild(templateID, buildID, {
				fromImage: "private/app",
				fromImageRegistry: { type: "aws" },
			}),
		).rejects.toBeInstanceOf(UnsupportedError);
		expect(service.status(templateID, buildID).status).toBe("error");
	});

	it("marks a build on an unknown template as failed instead of waiting forever", async () => {
		const { docker } = fakeDocker();
		vi.mocked(docker.resolveImage).mockRejectedValueOnce(
			new NotFoundError('Template "nope" not found'),
		);
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "on-nope" });
		await expect(
			service.startBuild(templateID, buildID, { fromTemplate: "nope" }),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(service.status(templateID, buildID).status).toBe("error");
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

	it("lists one entry per snapshot, its newest build unless a tag is asked for", async () => {
		const image = (ref: string, labels: Record<string, string>) => ({
			ref: `sandbox-${ref}`,
			id: ref,
			createdAt: "2026-10-28T00:00:00.000Z",
			labels: { "e2b.snapshot": "true", "e2b.snapshot-of": "sbx-a", ...labels },
		});
		const docker = {
			listTemplateImages: vi.fn(async () => [
				image("app:default", {
					"e2b.snapshot-name": "app",
					"e2b.snapshot-at": "1",
				}),
				image("app:v2", { "e2b.snapshot-name": "app", "e2b.snapshot-at": "2" }),
				image("snapshot-x:default", { "e2b.snapshot-name": "" }),
				// Made before the name label existed: named.
				image("old:default", { "e2b.snapshot-of": "sbx-b" }),
			]),
		} as unknown as DockerService;
		const service = new TemplateService(docker, filesDir);

		expect(await service.listSnapshots()).toEqual([
			{ snapshotID: "app:v2", names: ["app"] },
			{ snapshotID: "snapshot-x:default", names: [] },
			{ snapshotID: "old:default", names: ["old"] },
		]);
		expect(await service.listSnapshots(undefined, "app")).toEqual([
			{ snapshotID: "app:v2", names: ["app"] },
		]);
		expect(await service.listSnapshots(undefined, "app:default")).toEqual([
			{ snapshotID: "app:default", names: ["app"] },
		]);
		expect(await service.listSnapshots(undefined, "app:missing")).toEqual([]);
		expect(await service.listSnapshots(undefined, "snapshot-x")).toEqual([
			{ snapshotID: "snapshot-x:default", names: [] },
		]);
		expect(await service.listSnapshots("sbx-b")).toEqual([
			{ snapshotID: "old:default", names: ["old"] },
		]);
	});

	it("gives builds UUIDs, as E2B does, the same for one image", async () => {
		const imageId = `sha256:${"ab12".repeat(16)}`;
		const docker = {
			templateExists: vi.fn(async () => true),
			tagTemplate: vi.fn(async () => imageId),
			listTemplateImages: vi.fn(async () => [
				{
					ref: "sandbox-app:latest",
					id: imageId,
					createdAt: "2026-10-28T00:00:00.000Z",
					labels: {},
				},
			]),
		} as unknown as DockerService;
		const service = new TemplateService(docker, filesDir);
		const uuid =
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

		const { buildID } = await service.assignTags("app", ["v1"]);
		expect(buildID).toMatch(uuid);
		const [tag] = await service.listTags("app");
		expect(tag?.buildID).toBe(buildID);
		expect(service.requestBuild({ name: "app" }).buildID).toMatch(uuid);
	});

	it("does not know builds of another template", () => {
		const { docker } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { buildID } = service.requestBuild({ name: "one" });
		expect(() => service.status("two", buildID)).toThrow(NotFoundError);
	});

	it("rejects a COPY step whose filesHash would escape the files store", async () => {
		const { docker } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({ name: "evil" });
		await expect(
			service.startBuild(templateID, buildID, {
				fromTemplate: "base",
				steps: [
					{
						type: "COPY",
						args: ["a", "/a"],
						filesHash: "../../../../tmp/x",
					},
				],
			}),
		).rejects.toThrow(UnsupportedError);
	});

	it("applies requested tags after a successful build", async () => {
		const tagTemplate = vi.fn(async () => "sha256:deadbeef");
		const { docker } = fakeDocker();
		(
			docker as DockerService & {
				tagTemplate: typeof tagTemplate;
			}
		).tagTemplate = tagTemplate;
		const service = new TemplateService(docker, filesDir);
		const { templateID, buildID } = service.requestBuild({
			name: "tagged",
			tags: ["v1", "stable"],
		});
		await service.startBuild(templateID, buildID, { fromTemplate: "base" });
		await waitForStatus(service, templateID, buildID);
		expect(tagTemplate).toHaveBeenCalledWith("tagged", ["v1", "stable"]);
	});

	it("evicts the oldest finished builds beyond the most recent 100 on a new request", async () => {
		const { docker } = fakeDocker();
		const service = new TemplateService(docker, filesDir);
		const finished: string[] = [];
		for (let i = 0; i < 101; i++) {
			const { templateID, buildID } = service.requestBuild({ name: "app" });
			finished.push(buildID);
			await service.startBuild(templateID, buildID, { fromTemplate: "base" });
			await waitForStatus(service, templateID, buildID);
		}
		const oldest = finished[0];
		if (!oldest) throw new Error("expected a finished build");
		expect(service.status("app", oldest).status).toBe("ready");

		service.requestBuild({ name: "app" });

		expect(() => service.status("app", oldest)).toThrow(NotFoundError);
		const newestKept = finished[100];
		if (!newestKept) throw new Error("expected a finished build");
		expect(service.status("app", newestKept).status).toBe("ready");
	});
});
