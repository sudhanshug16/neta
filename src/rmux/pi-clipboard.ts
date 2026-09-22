import { execFileSync } from "node:child_process";

/** Copy through the client terminal's native transport (Termux) or OSC 52. */
export function copyToClipboard(text: string): void {
	if (process.env.TERMUX_VERSION !== undefined) {
		try {
			execFileSync("termux-clipboard-set", [], {
				input: text,
				stdio: ["pipe", "ignore", "ignore"],
				timeout: 5_000,
			});
			return;
		} catch {
			// OSC 52 remains available through the SSH terminal.
		}
	}
	const encoded = Buffer.from(text, "utf8").toString("base64");
	if (encoded.length > 100_000) throw new Error("Clipboard text is too large for OSC 52");
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
}
