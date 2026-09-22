import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../store/files.ts";

export interface RoutingAuthStatus {
	configured: boolean;
	source: "saved" | "environment" | "none";
	error?: string;
}

function validKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

// Read for every delegation so an already-running Node sees replacements immediately.
// Saved credentials win over an inherited environment variable.
export async function routingCredential(
	root: string,
): Promise<{ key: string | undefined; source: RoutingAuthStatus["source"] }> {
	let file: FileHandle | undefined;
	try {
		file = await open(join(root, "routing-auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("Cannot read the saved Jev key. Save it again in /routing.");
	}
	if (file) {
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > 16_384) throw new Error();
			const data: unknown = JSON.parse(await file.readFile("utf8"));
			if (
				!data ||
				typeof data !== "object" ||
				!("version" in data) ||
				data.version !== 1 ||
				!("jevApiKey" in data) ||
				!validKey(data.jevApiKey)
			)
				throw new Error();
			return { key: data.jevApiKey, source: "saved" };
		} catch {
			// JSON parse errors can contain the input; never propagate them to callers or logs.
			throw new Error("The saved Jev key is unreadable. Save it again in /routing.");
		} finally {
			await file.close();
		}
	}
	const key = process.env.TYPESAFE_API_KEY?.trim();
	if (key && !validKey(key)) throw new Error("TYPESAFE_API_KEY is invalid. Save a Jev key in /routing.");
	return { key: key || undefined, source: key ? "environment" : "none" };
}

export async function routingAuthStatus(root: string): Promise<RoutingAuthStatus> {
	try {
		const { key, source } = await routingCredential(root);
		return { configured: !!key, source };
	} catch {
		return { configured: false, source: "none", error: "Cannot read the Jev key. Save a replacement below." };
	}
}

export async function saveRoutingKey(root: string, value: string): Promise<void> {
	const key = value.trim();
	if (!validKey(key))
		throw new Error("Enter a Jev API key without spaces or control characters (up to 4096 characters).");
	const path = join(root, "routing-auth.json");
	const temporary = `${path}.tmp-${randomUUID()}`;
	try {
		await ensureDir(root);
		// Private from creation, including the temporary file; never follow an existing link.
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify({ version: 1, jevApiKey: key })}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
		const directory = await open(root, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch {
		throw new Error("Could not save the Jev key. Check access to the Neta data directory on this machine.");
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}
