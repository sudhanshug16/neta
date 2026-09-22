import { expect, test } from "bun:test";
import { parse } from "../src/cli/main.ts";

test("Toad launches live by default and demo only on explicit request", () => {
	expect(parse(["tui"])).toEqual({ name: "tui", args: [], flags: {} });
	expect(parse(["tui", "--demo"])).toEqual({ name: "tui", args: [], flags: { demo: true } });
	expect(parse(["tui", "--unknown"])).toHaveProperty("usage");
	expect(parse(["tui", "--demo", "extra"])).toHaveProperty("usage");
});
