import { expect, test } from "bun:test";
import { selectWorkerModel } from "../src/node/worker-model.ts";
const models = [{ id: "openai/astra" }, { id: "openai/small" }];
test("explicit lighter model remains selected", () => {
 expect(selectWorkerModel({ provider: "opencode", model: "openai/small" }, models).model).toBe("openai/small");
 expect(selectWorkerModel({ provider: "openai", model: "small" }, models).model).toBe("openai/small");
});
test("missing requested model never silently becomes the leader or first model", () => {
 expect(() => selectWorkerModel({ provider: "opencode", model: "missing-small" }, models)).toThrow("No substitute was launched");
 expect(() => selectWorkerModel({ provider: "opencode", model: "openai/small" }, [])).toThrow("/connect");
});
