import { customAlphabet, nanoid } from "nanoid";

// Lowercase alphanumerics only, like E2B's sandbox IDs: hostnames are
// case-insensitive (browsers lowercase them), so a mixed-case ID in
// `<port>-<id>.<domain>` would not route back to its sandbox.
const sandboxIdSuffix = customAlphabet(
	"0123456789abcdefghijklmnopqrstuvwxyz",
	12,
);

export function generateSandboxId(): string {
	return `sbx-${sandboxIdSuffix()}`;
}

/** The client ID E2B returns for backwards compatibility; old hosts embed one. */
export const E2B_CLIENT_ID = "6532622b";

export function generateAccessToken(): string {
	return nanoid(32);
}

/** Docker image names allow only some punctuation patterns, so suffixes stay alphanumeric. */
export const generateImageSuffix = customAlphabet(
	"0123456789abcdefghijklmnopqrstuvwxyz",
	12,
);

/**
 * A Docker repository name component: lowercase alphanumerics separated by
 * ".", "_", "__", or runs of "-", never at either end.
 */
export function isImageName(name: string): boolean {
	return (
		name.length <= 128 && /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(name)
	);
}
