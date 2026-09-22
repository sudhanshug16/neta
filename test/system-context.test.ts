import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppliedSystemContext, systemContextPath, writeSystemContext } from "../src/acp/system-context.ts";

describe("Neta system instruction contract", () => {
	test("atomic bundles and only matching local acknowledgments survive context and binding changes", async () => {
		const previous = process.env.NETA_DIR;
		const dir = mkdtempSync(join(tmpdir(), "neta-context-"));
		process.env.NETA_DIR = dir;
		try {
			const input = {
				sessionId: "session",
				actorId: "actor",
				bindingGeneration: "generation-1",
				role: "lead" as const,
				text: "Current charter",
			};
			const bundle = await writeSystemContext(input);
			const file = systemContextPath(input.sessionId);
			expect(JSON.parse(await readFile(file, "utf8"))).toEqual(bundle);
			expect((await stat(file)).mode & 0o777).toBe(0o600);
			expect(bundle.generation).toBe(input.bindingGeneration);
			expect(await readAppliedSystemContext(input.sessionId, input.bindingGeneration)).toBeUndefined();
			const { text: _text, role: _role, ...metadata } = bundle;
			const receipt = { ...metadata, hook: "context", accidentalText: "must not escape" };
			await writeFile(`${file}.applied.json`, JSON.stringify(receipt));
			const applied = await readAppliedSystemContext(input.sessionId, input.bindingGeneration);
			expect(applied).toEqual({ ...metadata, hook: "context" });
			expect(JSON.stringify(applied)).not.toContain("charter");
			expect(JSON.stringify(applied)).not.toContain("accidentalText");
			expect(await readAppliedSystemContext(input.sessionId, "generation-2")).toBeUndefined();
			await writeSystemContext({ ...input, text: "Changed charter" });
			expect(await readAppliedSystemContext(input.sessionId, input.bindingGeneration)).toBeUndefined();
			await writeFile(`${file}.applied.json`, "torn{");
			expect(await readAppliedSystemContext(input.sessionId, input.bindingGeneration)).toBeUndefined();
			await expect(writeSystemContext({ ...input, actorId: "" })).rejects.toThrow("current actor");
		} finally {
			if (previous === undefined) delete process.env.NETA_DIR;
			else process.env.NETA_DIR = previous;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
