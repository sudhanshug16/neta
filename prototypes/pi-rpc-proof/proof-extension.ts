import { writeFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function proofExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "proof_tool",
		label: "RPC proof tool",
		description: "Exercises an extension dialog and tool updates through Pi RPC.",
		parameters: Type.Object({ note: Type.String() }),
		async execute(_id, params, _signal, onUpdate, ctx) {
			const confirmed = await ctx.ui.confirm("Remote confirmation", `Run: ${params.note}?`);
			if (confirmed && process.env.PROOF_HOST_MARKER) await writeFile(process.env.PROOF_HOST_MARKER, `HOST_ONLY_MARKER cwd=${process.cwd()}`);
			onUpdate({ content: [{ type: "text", text: `confirmed=${confirmed}` }] });
			ctx.ui.notify(`tool completed: ${confirmed}`, "info");
			return {
				content: [{ type: "text", text: `proof tool completed (${confirmed}) HOST_ONLY_MARKER cwd=${process.cwd()}` }],
				details: { confirmed, note: params.note },
			};
		},
	});
}
