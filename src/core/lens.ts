// The time lens: linear inside the focus window, logarithmically compressed
// outside it on both sides. The desktop ports this to Swift in workstream 10
// against `test/fixtures/lens-cases.json`; change the math and the fixture
// together.
//
// Coordinates: `x(now) === width`, so the leader sits at the live right edge.
// Time runs in epoch milliseconds, space in points.
export interface LensOptions {
	now: number;
	focusStart: number;
	focusEnd: number;
	width: number;
	minPxPerHour: number;
}

export interface LensTick {
	t: number;
	label: string;
}

export interface Lens {
	x(t: number): number;
	t(x: number): number;
	ticks(): LensTick[];
}

const MS_PER_HOUR = 3_600_000;

// Manifesto tick labels, newest last.
const TICK_STEPS: [string, number][] = [
	["4w", 28 * 24 * MS_PER_HOUR],
	["2w", 14 * 24 * MS_PER_HOUR],
	["1w", 7 * 24 * MS_PER_HOUR],
	["3d", 3 * 24 * MS_PER_HOUR],
	["1d", 24 * MS_PER_HOUR],
	["12h", 12 * MS_PER_HOUR],
	["3h", 3 * MS_PER_HOUR],
	["1h", MS_PER_HOUR],
];

export function lens(opts: LensOptions): Lens {
	const span = Math.max(opts.focusEnd - opts.focusStart, 1);
	const pxPerMs = Math.max(opts.minPxPerHour / MS_PER_HOUR, opts.width / span);
	const startX = opts.width - (opts.now - opts.focusStart) * pxPerMs;
	const endX = opts.width - (opts.now - opts.focusEnd) * pxPerMs;
	const unit = pxPerMs * MS_PER_HOUR;

	function x(t: number): number {
		if (t >= opts.focusStart && t <= opts.focusEnd) {
			return opts.width - (opts.now - t) * pxPerMs;
		}
		if (t < opts.focusStart) {
			return startX - unit * Math.log1p((opts.focusStart - t) / MS_PER_HOUR);
		}
		return endX + unit * Math.log1p((t - opts.focusEnd) / MS_PER_HOUR);
	}

	function t(xPos: number): number {
		if (xPos >= startX && xPos <= endX) {
			return opts.now - (opts.width - xPos) / pxPerMs;
		}
		if (xPos < startX) {
			return opts.focusStart - Math.expm1((startX - xPos) / unit) * MS_PER_HOUR;
		}
		return opts.focusEnd + Math.expm1((xPos - endX) / unit) * MS_PER_HOUR;
	}

	function ticks(): LensTick[] {
		const out: LensTick[] = [];
		for (const [label, back] of TICK_STEPS) {
			const at = opts.now - back;
			const pos = x(at);
			if (pos >= 0 && pos <= opts.width) {
				out.push({ t: at, label });
			}
		}
		if (opts.width >= 0) {
			out.push({ t: opts.now, label: "now" });
		}
		return out;
	}

	return { x, t, ticks };
}
