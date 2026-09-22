import { NodeError } from "./protocol.ts";

export function selectWorkerModel(
	input: { provider: string; model: string },
	available: readonly { id: string }[],
): { provider: string; model: string } {
	const selected = available.find((model) => model.id === input.model)
		?? available.find((model) => model.id === `${input.provider}/${input.model}`);
	if (!selected) throw new NodeError("PROVIDER_ERROR",
		`Requested worker model ${input.model} is unavailable. No substitute was launched. Choose an exact model from neta_status.modelCatalog, or repair its connection with /connect. Available: ${available.map((model) => model.id).join(", ") || "none"}`);
	return { provider: "opencode", model: selected.id };
}
