// Leave room for the tool transport envelope around a serialized result.
export const DEFAULT_READ_BYTES = 4 * 1024 - 128;
export const DETAIL_READ_BYTES = 8 * 1024 - 128;
export const TEXT_PAGE_BYTES = 2 * 1024;

export function utf8Excerpt(value: string, bytes: number): { text: string; truncated: boolean } {
	const encoded = Buffer.from(value, "utf8");
	if (encoded.length <= bytes) return { text: value, truncated: false };
	let end = bytes;
	while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--;
	return { text: new TextDecoder().decode(encoded.subarray(0, end)), truncated: true };
}

export function fitPage<T>(
	items: readonly T[],
	start: number,
	limit: number,
	budget: number,
	envelope: (page: T[], hasMore: boolean) => unknown,
): T[] {
	const page: T[] = [];
	for (let index = start; index < items.length && page.length < limit; index++) {
		const item = items[index];
		if (item === undefined) break;
		const candidate = [...page, item];
		if (Buffer.byteLength(JSON.stringify(envelope(candidate, index + 1 < items.length)), "utf8") > budget) break;
		page.push(item);
	}
	if (page.length === 0 && start < items.length) throw new Error("a single record exceeds the tool response budget");
	return page;
}

export function textPage(value: string, cursor?: string): { text: string; truncated: boolean; nextCursor?: string } {
	const offset = cursor === undefined ? 0 : Number(cursor);
	const encoded = Buffer.from(value, "utf8");
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > encoded.length) throw new Error("invalid text cursor");
	if (offset < encoded.length && ((encoded[offset] ?? 0) & 0xc0) === 0x80)
		throw new Error("invalid text cursor boundary");
	let end = Math.min(encoded.length, offset + TEXT_PAGE_BYTES);
	while (end < encoded.length && end > offset && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--;
	const text = new TextDecoder().decode(encoded.subarray(offset, end));
	return { text, truncated: end < encoded.length, ...(end < encoded.length ? { nextCursor: String(end) } : {}) };
}

export function scopedTextPage(value: string, scope: string, cursor?: string): ReturnType<typeof textPage> {
	let offset: string | undefined;
	if (cursor !== undefined) {
		const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
		if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== scope || typeof decoded[1] !== "string")
			throw new Error("cursor belongs to another text field");
		offset = decoded[1];
	}
	const page = textPage(value, offset);
	return {
		text: page.text,
		truncated: page.truncated,
		...(page.nextCursor
			? { nextCursor: Buffer.from(JSON.stringify([scope, page.nextCursor])).toString("base64url") }
			: {}),
	};
}
