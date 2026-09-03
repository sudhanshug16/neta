// Deterministic mission branch names, pure and dependency-free. Branches
// are `mission/<number>-<slug>` from the mission's base.
export function slugify(name: string): string {
	const ascii = name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (ascii === "") {
		return "mission";
	}
	if (ascii.length <= 32) {
		return ascii;
	}
	const cut = ascii.slice(0, 32);
	const dash = cut.lastIndexOf("-");
	return dash === -1 ? cut : cut.slice(0, dash);
}

export function missionBranch(n: number, slug: string): string {
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(`mission number is a positive integer, got ${n}`);
	}
	return `mission/${n}-${slug}`;
}

export function parseMissionBranch(b: string): { number: number; slug: string } | undefined {
	const match = /^mission\/([1-9]\d*)-([a-z0-9-]{1,32})$/.exec(b);
	if (match === null) {
		return undefined;
	}
	return { number: Number.parseInt(match[1] ?? "0", 10), slug: match[2] ?? "" };
}
