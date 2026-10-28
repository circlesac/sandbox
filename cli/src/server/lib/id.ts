import { customAlphabet, nanoid } from "nanoid";

export function generateSandboxId(): string {
	return `sbx-${nanoid(12)}`;
}

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
