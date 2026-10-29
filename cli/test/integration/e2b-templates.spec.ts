import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox, Template } from "e2b";
import { afterAll, describe, expect, it } from "vitest";

const SERVER_INFO_PATH = "/tmp/sandbox-integration-test.json";

const serverInfo: { port: number; apiKey: string } | null = existsSync(
	SERVER_INFO_PATH,
)
	? JSON.parse(readFileSync(SERVER_INFO_PATH, "utf-8"))
	: null;

const url = serverInfo ? `http://localhost:${serverInfo.port}` : "";
const opts = serverInfo
	? { apiUrl: url, apiKey: serverInfo.apiKey, sandboxUrl: url }
	: undefined;

/** Names unique to this run, so repeated runs never see each other's images. */
const run = Date.now().toString(36);

describe.skipIf(!opts)(
	"E2B templates, snapshots, forks, metrics",
	{ timeout: 600_000 },
	() => {
		const sandboxIds: string[] = [];
		const templateNames: string[] = [];

		afterAll(async () => {
			await Promise.allSettled(sandboxIds.map((id) => Sandbox.kill(id, opts)));
			await Promise.allSettled(
				templateNames.map((name) => Sandbox.deleteSnapshot(name, opts)),
			);
		}, 120_000);

		/** SDKs before fork() existed: call the API, then connect to each fork. */
		async function forkWithoutSdk(sandboxId: string, count: number) {
			const res = await fetch(`${url}/sandboxes/${sandboxId}/fork`, {
				method: "POST",
				headers: {
					"X-API-Key": serverInfo?.apiKey ?? "",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ count }),
			});
			expect(res.status).toBe(201);
			const results = (await res.json()) as {
				sandbox?: { sandboxID: string };
			}[];
			return Promise.all(
				results.map((r) => Sandbox.connect(r.sandbox?.sandboxID ?? "", opts)),
			);
		}

		async function create(template = "base") {
			const sandbox = await Sandbox.create(template, opts);
			sandboxIds.push(sandbox.sandboxId);
			return sandbox;
		}

		it("reports a running sandbox's resource use", async () => {
			const sandbox = await create();
			const metrics = await sandbox.getMetrics();
			expect(metrics).toHaveLength(1);
			const [sample] = metrics;
			expect(sample?.cpuCount).toBeGreaterThan(0);
			expect(sample?.memTotal).toBeGreaterThan(0);
			expect(sample?.diskTotal).toBeGreaterThan(0);
		});

		it("snapshots a sandbox's files and creates sandboxes from the snapshot", async () => {
			const source = await create();
			await source.files.write("/home/user/note.txt", "kept in the snapshot");
			const snapshot = await source.createSnapshot({ name: `snap-${run}` });
			templateNames.push(snapshot.snapshotId);
			expect(snapshot.snapshotId).toBe(`snap-${run}:default`);

			const listed = await Sandbox.listSnapshots(opts).nextItems();
			expect(listed.map((s) => s.snapshotId)).toContain(snapshot.snapshotId);

			const restored = await create(snapshot.snapshotId);
			expect(await restored.files.read("/home/user/note.txt")).toBe(
				"kept in the snapshot",
			);

			expect(await Sandbox.deleteSnapshot(snapshot.snapshotId, opts)).toBe(
				true,
			);
			expect(await Sandbox.deleteSnapshot(snapshot.snapshotId, opts)).toBe(
				false,
			);
		});

		it("refuses a memory snapshot, which Docker cannot take", async () => {
			const source = await create();
			const res = await fetch(
				`${url}/sandboxes/${source.sandboxId}/snapshots`,
				{
					method: "POST",
					headers: {
						"X-API-Key": serverInfo?.apiKey ?? "",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ memory: true }),
				},
			);
			expect(res.status).toBe(400);
			expect(await res.text()).toContain("Memory snapshots are not supported");
		});

		it("forks a sandbox's files into new sandboxes", async () => {
			const source = await create();
			await source.files.write("/home/user/fork.txt", "from the parent");
			const forks =
				"fork" in Sandbox.prototype
					? ((await (
							source as unknown as {
								fork(o: { count: number }): Promise<unknown[]>;
							}
						).fork({ count: 2 })) as Sandbox[])
					: await forkWithoutSdk(source.sandboxId, 2);
			expect(forks).toHaveLength(2);
			for (const fork of forks) {
				expect(fork).toBeInstanceOf(Sandbox);
				sandboxIds.push(fork.sandboxId);
				expect(fork.sandboxId).not.toBe(source.sandboxId);
				expect(await fork.files.read("/home/user/fork.txt")).toBe(
					"from the parent",
				);
			}

			// The forks share one saved image, which exists only for them:
			// it survives the first fork and goes with the last.
			const docker = (...args: string[]) =>
				spawnSync("docker", args, { encoding: "utf-8" });
			const imageId = docker(
				"inspect",
				"--format",
				"{{.Image}}",
				forks[0]?.sandboxId ?? "",
			).stdout.trim();
			expect(imageId).toMatch(/^sha256:/);
			const imageExists = () =>
				docker("image", "inspect", imageId).status === 0;
			await forks[0]?.kill();
			expect(imageExists()).toBe(true);
			await forks[1]?.kill();
			expect(imageExists()).toBe(false);
		});

		it("builds a template from the base template with run, copy, env, and a start command", async () => {
			const context = mkdtempSync(join(tmpdir(), "sandbox-template-ctx-"));
			writeFileSync(join(context, "greeting.txt"), "copied into the template");
			const name = `tpl-${run}`;
			templateNames.push(name);

			const template = Template({ fileContextPath: context })
				.fromTemplate("base")
				.runCmd("echo built > /home/user/built.txt")
				// A multi-line command must stay one build step.
				.runCmd("cat > /home/user/multi.txt <<'EOF'\nline one\nline two\nEOF")
				.copy("greeting.txt", "/home/user/greeting.txt")
				.setEnvs({ TEMPLATE_FLAVOR: "vanilla" })
				.setStartCmd(
					"python3 -m http.server 8000 --directory /home/user",
					"curl -sf http://localhost:8000/built.txt",
				);
			const logs: string[] = [];
			await Template.build(template, name, {
				...opts,
				onBuildLogs: (entry) => logs.push(entry.message),
			});
			expect(logs.join("\n")).toContain("Built sandbox-");
			expect(await Template.exists(name, opts)).toBe(true);

			const sandbox = await create(name);
			expect(
				(await sandbox.commands.run("cat /home/user/built.txt")).stdout.trim(),
			).toBe("built");
			expect(await sandbox.files.read("/home/user/greeting.txt")).toBe(
				"copied into the template",
			);
			expect(await sandbox.files.read("/home/user/multi.txt")).toBe(
				"line one\nline two\n",
			);
			expect(
				(await sandbox.commands.run("echo $TEMPLATE_FLAVOR")).stdout.trim(),
			).toBe("vanilla");
			// The start command was running and ready before create returned.
			const served = await sandbox.commands.run(
				"curl -sf http://localhost:8000/built.txt",
			);
			expect(served.stdout.trim()).toBe("built");
		});

		it("builds a template from a plain image, adding envd and the default user", async () => {
			const name = `img-${run}`;
			templateNames.push(name);
			const template = Template()
				.fromImage("debian:bookworm-slim")
				.runCmd("echo from-debian > /etc/flavor");
			await Template.build(template, name, opts);

			const sandbox = await create(name);
			expect(
				(await sandbox.commands.run("cat /etc/flavor")).stdout.trim(),
			).toBe("from-debian");
			expect((await sandbox.commands.run("whoami")).stdout.trim()).toBe("user");
		});

		it("reports a failing build with its error", async () => {
			const template = Template().fromTemplate("base").runCmd("exit 7");
			await expect(
				Template.build(template, `bad-${run}`, opts),
			).rejects.toThrow(/exit|code|returned a non-zero/i);
		});

		it("tags a template and lists and removes its tags", async () => {
			const name = `tags-${run}`;
			templateNames.push(name);
			await Template.build(Template().fromTemplate("base"), name, opts);

			await Template.assignTags(name, ["v1", "stable"], opts);
			const tags = (await Template.getTags(name, opts))
				.map((t) => t.tag)
				.sort();
			expect(tags).toEqual(["latest", "stable", "v1"]);

			const tagged = await create(`${name}:v1`);
			expect(tagged.sandboxId).toMatch(/^sbx-/);

			await Template.removeTags(name, ["stable"], opts);
			expect(
				(await Template.getTags(name, opts)).map((t) => t.tag).sort(),
			).toEqual(["latest", "v1"]);
			expect(await Template.exists(`missing-${run}`, opts)).toBe(false);
		});

		it("answers 501 for volumes and secrets", async () => {
			const res = await fetch(`${url}/volumes`, {
				headers: { "X-API-Key": serverInfo?.apiKey ?? "" },
			});
			expect(res.status).toBe(501);
			expect(await res.text()).toContain("Volumes are not supported");
			const secrets = await fetch(`${url}/secrets`, {
				headers: { "X-API-Key": serverInfo?.apiKey ?? "" },
			});
			expect(secrets.status).toBe(501);
		});
	},
);
