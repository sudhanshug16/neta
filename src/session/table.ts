import type { Access, SessionId } from "../core/types.ts";
import type { RuntimeSession } from "./runtime.ts";
import type { Settings } from "./settings.ts";

export interface SessionRecord {
	session: RuntimeSession;
	provider: string;
	netaTools?: boolean;
}

export class SessionTable {
	readonly defaults: { settings: Settings; cwd: string; access: Access };
	private records = new Map<SessionId, SessionRecord>();
	constructor(defaults: { settings: Settings; cwd: string; access: Access }) {
		this.defaults = defaults;
	}
	get(sessionId: SessionId): SessionRecord | undefined {
		return this.records.get(sessionId);
	}
	set(sessionId: SessionId, record: SessionRecord): void {
		this.records.set(sessionId, record);
	}
	delete(sessionId: SessionId): void {
		this.records.delete(sessionId);
	}
	values(): SessionRecord[] {
		return [...this.records.values()];
	}
	clear(): void {
		this.records.clear();
	}
}
