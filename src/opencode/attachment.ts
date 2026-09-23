import { type OpenCodeExecutionContract, openCodeExecutionContract } from "./contract.ts";

/** The private native renderer endpoint advertised by the Neta OpenCode fork. */
export interface OpenCodeEndpoint {
	url: string;
	apiVersion?: 2;
	contract?: OpenCodeExecutionContract;
	authorization: string;
}

export interface OpenCodeAttachment extends OpenCodeEndpoint {
	sessionId: string;
	directory: string;
}

export function openCodeEndpoint(meta: unknown): OpenCodeEndpoint | undefined {
	if (typeof meta !== "object" || meta === null || !("neta.opencode" in meta)) return undefined;
	const value = meta["neta.opencode"];
	if (typeof value !== "object" || value === null || !("url" in value) || !("authorization" in value))
		return undefined;
	if (typeof value.url !== "string" || typeof value.authorization !== "string") return undefined;
	const url = new URL(value.url);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/")
		throw new Error("OpenCode advertised an invalid local endpoint");
	if (!value.authorization.startsWith("Basic ")) throw new Error("OpenCode endpoint requires authentication");
	const contract = openCodeExecutionContract("contract" in value ? value.contract : undefined);
	return {
		url: url.origin,
		...(contract === undefined ? {} : { contract }),
		authorization: value.authorization,
		...("apiVersion" in value && value.apiVersion === 2 ? { apiVersion: 2 as const } : {}),
	};
}

/** A view must not receive an endpoint without a live private OpenCode server. */
export async function nativeEndpointReady(attachment: OpenCodeAttachment): Promise<boolean> {
	try {
		const url = new URL(
			`${attachment.apiVersion === 2 ? "/api" : ""}/session/${encodeURIComponent(attachment.sessionId)}`,
			attachment.url,
		);
		url.searchParams.set("directory", attachment.directory);
		const response = await fetch(url, {
			headers: { Authorization: attachment.authorization },
			signal: AbortSignal.timeout(3000),
		});
		await response.body?.cancel();
		return response.ok;
	} catch {
		return false;
	}
}
