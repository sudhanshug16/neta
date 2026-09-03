// ISO 8601 UTC millisecond time helpers. The wire format is always
// `Date.toISOString()` output, e.g. `2026-09-03T17:00:00.000Z`.
export function nowIso(): string {
	return new Date().toISOString();
}

export function parseIso(text: string): number {
	const ms = Date.parse(text);
	if (Number.isNaN(ms)) {
		throw new RangeError(`invalid ISO time: ${text}`);
	}
	return ms;
}

export function msBetween(a: string, b: string): number {
	return parseIso(b) - parseIso(a);
}
