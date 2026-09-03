import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { WorkspaceId, WorkspaceKind } from "./types.ts";

// Canonicalises a Git remote to `host/owner/repo`: equivalent SSH and HTTPS
// forms of one repository give one string, so two clones group into one
// workspace. Pure string work: no network, no `git` call.
export function canonicalRemote(url: string): string {
	let rest = url.trim().replace(/\/+$/, "");
	if (rest.endsWith(".git")) {
		rest = rest.slice(0, -4);
	}
	const scp = /^[^@/:]+@([^:]+):(.+)$/.exec(rest);
	if (scp) {
		return joinRemote(scp[1], scp[2]);
	}
	const scheme = /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(rest);
	if (scheme) {
		return joinRemote(scheme[1], scheme[2]);
	}
	return joinRemote("", rest);
}

function joinRemote(host: string, path: string): string {
	const cleanPath = path.replace(/^\/+/, "");
	return host.toLowerCase() + (cleanPath === "" ? "" : `/${cleanPath}`);
}

export function workspaceIdFor(input: { kind: WorkspaceKind; remote?: string; path: string }): WorkspaceId {
	if (input.kind === "git") {
		if (input.remote === undefined || input.remote === "") {
			throw new Error("a git workspace needs a remote");
		}
		return `git:${canonicalRemote(input.remote)}`;
	}
	const digest = createHash("sha256").update(resolve(input.path)).digest("hex").slice(0, 16);
	return `folder:${digest}`;
}
