import type { NodeRuntime, SessionRequest } from "../node/server.ts";

/** Reserve one durable identity, creating it once and resuming only after successful initialization. */
export async function openPersistedRuntimeSession(input: {
	runtime: Pick<NodeRuntime, "createSession" | "ensureSession">;
	request: SessionRequest & { sessionId: string };
	initialized: boolean;
	markInitialized(): Promise<unknown>;
}): ReturnType<NodeRuntime["createSession"]> {
	const selected = input.initialized
		? await input.runtime.ensureSession({ ...input.request, allowFresh: false })
		: await input.runtime.createSession(input.request);
	if (selected.sessionId !== input.request.sessionId)
		throw new Error("native runtime did not preserve its persisted session identity");
	if (!input.initialized) await input.markInitialized();
	return selected;
}
