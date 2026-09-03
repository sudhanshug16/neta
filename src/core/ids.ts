// ULID generation and validation. 26 chars of Crockford base32: 48 bits of
// millisecond time followed by 80 bits of randomness. Monotonic within a
// process: two calls in the same millisecond increment the random tail.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeTime(now: number): string {
	let value = now;
	let out = "";
	for (let i = 0; i < 10; i++) {
		out = CROCKFORD[value % 32] + out;
		value = Math.floor(value / 32);
	}
	return out;
}

function randomTail(): string {
	let out = "";
	for (let i = 0; i < 16; i++) {
		out += CROCKFORD[Math.floor(Math.random() * 32)];
	}
	return out;
}

function incrementTail(tail: string): string | undefined {
	const digits = tail.split("");
	for (let i = digits.length - 1; i >= 0; i--) {
		const next = CROCKFORD.indexOf(digits[i]) + 1;
		if (next < 32) {
			digits[i] = CROCKFORD[next];
			return digits.join("");
		}
		digits[i] = "0";
	}
	return undefined;
}

let lastTime = -1;
let lastTail = "";

export function ulid(now: number = Date.now()): string {
	if (now === lastTime) {
		const next = incrementTail(lastTail);
		if (next !== undefined) {
			lastTail = next;
			return encodeTime(now) + lastTail;
		}
		now = lastTime + 1;
	}
	lastTime = now;
	lastTail = randomTail();
	return encodeTime(now) + lastTail;
}

export function isUlid(value: string): boolean {
	return ULID_PATTERN.test(value);
}
