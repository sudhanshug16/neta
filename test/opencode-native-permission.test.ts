import { expect, test } from "bun:test";
import { nativePermissionReply } from "../src/opencode/direct-session.ts";

test("read-only Neta can call its scoped Neta tools", () => {
	for (const action of ["neta_missions", "neta_mission", "neta_send_message", "neta_artifacts"]) {
		expect(nativePermissionReply(action, "readOnly", false)).toBe("once");
	}
});

test("read-only access still rejects unrelated Neta and edit actions", () => {
	expect(nativePermissionReply("dispatch_mission", "readOnly", false)).toBe("reject");
	expect(nativePermissionReply("change_model", "readOnly", false)).toBe("reject");
	expect(nativePermissionReply("edit", "readOnly", false)).toBe("reject");
	expect(nativePermissionReply("execute", "readOnly", false)).toBe("once");
});

test("managed sessions deny native questions regardless of write access", () => {
	expect(nativePermissionReply("question", "readOnly", false)).toBe("reject");
	expect(nativePermissionReply("question", "readWrite", false)).toBe("reject");
});
