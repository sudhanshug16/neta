import { test } from "bun:test";
import { writeSync } from "node:fs";

test("writes alternating streams", () => {
	writeSync(1, "ORDER_ONE\n");
	writeSync(2, "ORDER_TWO\n");
	writeSync(1, "ORDER_THREE\n");
	writeSync(1, `SECRET_${process.env.NETA_EXEC_TEST_SECRET ?? "ABSENT"}\n`);
});
