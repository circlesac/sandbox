import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { NotFoundError, UnsupportedError } from "../errors.ts";
import { isImageName } from "../lib/id.ts";
import { type DockerService, templateImage } from "./docker.ts";

export type BuildStatus = "waiting" | "building" | "ready" | "error";

export interface BuildLogEntry {
	timestamp: string;
	level: "debug" | "info" | "warn" | "error";
	message: string;
}

interface Build {
	templateID: string;
	buildID: string;
	status: BuildStatus;
	logEntries: BuildLogEntry[];
	reason?: { message: string; step?: string };
}

/** One step of an E2B template, as Template().toJSON() serializes it. */
export interface TemplateStep {
	type: string;
	args?: string[];
	filesHash?: string;
	force?: boolean;
}

/** The body of POST /v2/templates/{templateID}/builds/{buildID}. */
export interface TemplateBuildStart {
	fromImage?: string;
	fromTemplate?: string;
	fromImageRegistry?: unknown;
	force?: boolean;
	steps?: TemplateStep[];
	startCmd?: string;
	readyCmd?: string;
}

/**
 * Builds E2B templates as Docker images named `sandbox-<name>:<tag>`, so a
 * template is created the same way a sandbox from it is: Sandbox.create(name).
 * Builds and their logs live in memory; built images persist in Docker.
 */
export class TemplateService {
	private builds = new Map<string, Build>();
	private uploadToken = randomBytes(24).toString("hex");

	constructor(
		private docker: DockerService,
		private filesDir = join(homedir(), ".sandbox", "template-files"),
	) {}

	requestBuild(req: { name?: string; tags?: string[] }) {
		const name = req.name ?? "";
		// Template names become Docker image names, so they follow those rules.
		if (!isImageName(name)) {
			throw new UnsupportedError(
				`Template name "${name}" must be lowercase letters, digits, ".", "_" or "-"`,
			);
		}
		const buildID = randomUUID();
		this.builds.set(buildID, {
			templateID: name,
			buildID,
			status: "waiting",
			logEntries: [],
		});
		const tags = req.tags ?? [];
		return {
			templateID: name,
			buildID,
			public: false,
			aliases: [name],
			names: [name],
			tags,
			pendingTags: tags,
		};
	}

	/** Where the SDK uploads a COPY step's files; present when already uploaded. */
	fileUploadLink(hash: string, origin: string) {
		const present = existsSync(this.filePath(hash));
		return {
			present,
			url: present
				? undefined
				: `${origin}/template-files/${hash}?token=${this.uploadToken}`,
		};
	}

	async storeUpload(
		hash: string,
		token: string | undefined,
		body: ArrayBuffer,
	) {
		if (token !== this.uploadToken)
			throw new NotFoundError("Unknown upload URL");
		if (!/^[a-zA-Z0-9_-]+$/.test(hash))
			throw new NotFoundError("Unknown upload URL");
		mkdirSync(this.filesDir, { recursive: true });
		const temp = `${this.filePath(hash)}.${nanoid()}.tmp`;
		writeFileSync(temp, Buffer.from(body));
		renameSync(temp, this.filePath(hash));
	}

	async startBuild(
		templateID: string,
		buildID: string,
		body: TemplateBuildStart,
	) {
		const build = this.builds.get(buildID);
		if (!build || build.templateID !== templateID) {
			throw new NotFoundError(
				`Build ${buildID} of template ${templateID} not found`,
			);
		}
		if (body.fromImageRegistry) {
			throw new UnsupportedError(
				"fromImageRegistry (private registry credentials)",
			);
		}
		// The agent comes from whichever copy of the base template is present.
		const envdImage = body.fromImage
			? await this.docker.resolveImage("base")
			: "";
		const context = this.prepareContext(body, envdImage);
		build.status = "building";
		void this.runBuild(build, body, context);
	}

	status(templateID: string, buildID: string, logsOffset = 0) {
		const build = this.builds.get(buildID);
		if (!build || build.templateID !== templateID) {
			throw new NotFoundError(
				`Build ${buildID} of template ${templateID} not found`,
			);
		}
		const logEntries = build.logEntries.slice(logsOffset);
		return {
			templateID,
			buildID,
			status: build.status,
			logEntries,
			logs: logEntries.map((e) => e.message),
			reason: build.reason,
		};
	}

	async aliasExists(alias: string) {
		return this.docker.templateExists(alias);
	}

	async assignTags(target: string, tags: string[]) {
		if (!(await this.docker.templateExists(target))) {
			throw new NotFoundError(`Template ${target} not found`);
		}
		const buildID = buildUuid(await this.docker.tagTemplate(target, tags));
		return { buildID, tags };
	}

	async removeTags(name: string, tags: string[]) {
		const { repo } = templateImage(name);
		await this.docker.removeTemplateImages(tags.map((tag) => `${repo}:${tag}`));
	}

	async listTags(templateID: string) {
		const { repo } = templateImage(templateID);
		const images = await this.docker.listTemplateImages();
		return images
			.filter((image) => image.ref.startsWith(`${repo}:`))
			.map((image) => ({
				tag: image.ref.slice(repo.length + 1),
				buildID: buildUuid(image.id),
				createdAt: image.createdAt,
			}));
	}

	/**
	 * One entry per snapshot, showing its newest build, as E2B lists them. A
	 * name filter with a tag (<name>:<tag>) shows that tag's build instead.
	 */
	async listSnapshots(sandboxId?: string, name?: string) {
		const [wantName, wantTag] = name?.split(":") ?? [];
		const builds = (await this.docker.listTemplateImages("e2b.snapshot=true"))
			.filter(
				(image) => !sandboxId || image.labels["e2b.snapshot-of"] === sandboxId,
			)
			.map((image) => {
				const snapshotID = image.ref.slice("sandbox-".length);
				const [repo = snapshotID, tag] = snapshotID.split(":");
				return {
					snapshotID,
					repo,
					tag,
					// Snapshots from before the label existed were all named.
					named: image.labels["e2b.snapshot-name"] !== "",
					at:
						Number(image.labels["e2b.snapshot-at"]) ||
						Date.parse(image.createdAt),
				};
			})
			.filter(
				(b) =>
					!wantName || (b.repo === wantName && (!wantTag || b.tag === wantTag)),
			);
		const newest = new Map<string, (typeof builds)[number]>();
		for (const build of builds) {
			const current = newest.get(build.repo);
			if (!current || build.at > current.at) newest.set(build.repo, build);
		}
		return [...newest.values()].map((b) => ({
			snapshotID: b.snapshotID,
			names: b.named ? [b.repo] : [],
		}));
	}

	/**
	 * Deletes a template or snapshot: with a tag (<name>:<tag>) only that tag,
	 * without one every tag. False when nothing matched.
	 */
	async deleteTemplate(templateID: string): Promise<boolean> {
		const { repo, tag } = templateImage(templateID);
		const refs = (await this.docker.listTemplateImages())
			.map((image) => image.ref)
			.filter((ref) =>
				templateID.includes(":")
					? ref === `${repo}:${tag}`
					: ref.startsWith(`${repo}:`),
			);
		return (await this.docker.removeTemplateImages(refs)) > 0;
	}

	private filePath(hash: string) {
		return join(this.filesDir, `${hash}.tar`);
	}

	/** Writes the Dockerfile and unpacks each COPY step's upload into a build context. */
	private prepareContext(body: TemplateBuildStart, envdImage: string): string {
		const dir = mkdtempSync(join(tmpdir(), "sandbox-template-"));
		const lines: string[] = [];
		let user = "root";

		if (body.fromTemplate) {
			const { repo, tag } = templateImage(body.fromTemplate);
			lines.push(`FROM ${repo}:${tag}`);
		} else if (body.fromImage) {
			// E2B injects its agent into any base image; take envd from the base template.
			lines.push(`FROM ${body.fromImage}`);
			lines.push(`COPY --from=${envdImage} /usr/bin/envd /usr/bin/envd`);
			lines.push(
				"RUN id -u user >/dev/null 2>&1 || useradd -m -s /bin/bash user 2>/dev/null || adduser -D -s /bin/sh user",
			);
			// See docker/sandbox/Dockerfile: envd reopens user files in /tmp as root.
			lines.push("RUN chmod 0777 /tmp /var/tmp");
		} else {
			throw new UnsupportedError(
				"A template build needs fromImage or fromTemplate",
			);
		}

		for (const [index, step] of (body.steps ?? []).entries()) {
			const args = step.args ?? [];
			switch (step.type) {
				case "RUN": {
					const [cmd, runAs] = args;
					if (runAs) lines.push(`USER ${runAs}`);
					lines.push(`RUN ${cmd}`);
					if (runAs) lines.push(`USER ${user}`);
					break;
				}
				case "COPY": {
					const [src, dest, owner, mode] = args;
					if (!step.filesHash || !src || !dest) {
						throw new UnsupportedError(
							`Step ${index + 1}: COPY needs files and a destination`,
						);
					}
					const filesDir = join(dir, "files", step.filesHash);
					mkdirSync(filesDir, { recursive: true });
					const tar = spawnSync("tar", [
						"-xf",
						this.filePath(step.filesHash),
						"-C",
						filesDir,
					]);
					if (tar.status !== 0) {
						throw new NotFoundError(
							`Step ${index + 1}: files for ${src} were not uploaded`,
						);
					}
					lines.push(
						`COPY ${owner ? `--chown=${owner} ` : ""}${JSON.stringify([`files/${step.filesHash}/${src}`, dest])}`,
					);
					if (mode) lines.push(`RUN chmod ${mode} ${JSON.stringify(dest)}`);
					break;
				}
				case "ENV": {
					const pairs: string[] = [];
					for (let i = 0; i + 1 < args.length; i += 2) {
						pairs.push(`${args[i]}=${JSON.stringify(args[i + 1])}`);
					}
					if (pairs.length > 0) lines.push(`ENV ${pairs.join(" ")}`);
					break;
				}
				case "WORKDIR":
					lines.push(`WORKDIR ${args[0]}`);
					break;
				case "USER":
					user = args[0] ?? "root";
					lines.push(`USER ${user}`);
					break;
				default:
					throw new UnsupportedError(
						`Step ${index + 1}: unknown step type ${step.type}`,
					);
			}
		}

		// envd runs as root and switches users per request, like the base image.
		lines.push("USER root");
		if (body.startCmd)
			lines.push(`LABEL e2b.start-cmd=${JSON.stringify(body.startCmd)}`);
		if (body.readyCmd)
			lines.push(`LABEL e2b.ready-cmd=${JSON.stringify(body.readyCmd)}`);
		lines.push("ENTRYPOINT []");
		// The base template's command: envd, plus sandbox-portf where present.
		lines.push(
			'CMD ["/bin/sh", "-c", "if [ -x /usr/local/bin/sandbox-portf ]; then /usr/local/bin/sandbox-portf & fi; exec /usr/bin/envd -isnotfc"]',
		);
		writeFileSync(join(dir, "Dockerfile"), `${lines.join("\n")}\n`);
		return dir;
	}

	private async runBuild(
		build: Build,
		body: TemplateBuildStart,
		context: string,
	) {
		const log = (message: string, level: BuildLogEntry["level"] = "info") =>
			build.logEntries.push({
				timestamp: new Date().toISOString(),
				level,
				message,
			});
		try {
			const entries = [
				"Dockerfile",
				...(existsSync(join(context, "files")) ? ["files"] : []),
			];
			await this.docker.buildTemplate(context, entries, build.templateID, {
				noCache: body.force === true,
				onLog: (line, isError) => log(line, isError ? "error" : "info"),
			});
			const errors = build.logEntries.filter((e) => e.level === "error");
			if (errors.length > 0)
				throw new Error(errors.map((e) => e.message).join("\n"));
			log(`Built ${templateImage(build.templateID).repo}:latest`);
			build.status = "ready";
		} catch (err) {
			build.status = "error";
			build.reason = {
				message: err instanceof Error ? err.message : String(err),
			};
			log(build.reason.message, "error");
		} finally {
			rmSync(context, { recursive: true, force: true });
		}
	}
}

/**
 * E2B build IDs are UUIDs; a Docker image ID (sha256:<64 hex>) becomes one
 * from its first 32 hex digits, so one image always has the same build ID.
 */
function buildUuid(imageId: string): string {
	const hex = imageId
		.replace(/^sha256:/, "")
		.slice(0, 32)
		.padEnd(32, "0");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}
