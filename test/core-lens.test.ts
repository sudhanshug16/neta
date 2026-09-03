import { describe, expect, test } from "bun:test";
import { lens } from "../src/core/lens.ts";
import fixture from "./fixtures/lens-cases.json" with { type: "json" };

interface LensCase {
	opts: { now: number; focusStart: number; focusEnd: number; width: number; minPxPerHour: number };
	samples: { t: number; x: number }[];
}

describe("lens", () => {
	test("matches every sample in the Swift-port fixture", () => {
		for (const c of fixture as LensCase[]) {
			const l = lens(c.opts);
			for (const s of c.samples) {
				expect(Math.abs(l.x(s.t) - s.x)).toBeLessThan(0.001);
			}
		}
	});

	test("is linear inside the focus window", () => {
		const now = 1_787_712_000_000;
		const l = lens({ now, focusStart: now - 24 * 3_600_000, focusEnd: now, width: 1600, minPxPerHour: 8 });
		const a = now - 20 * 3_600_000;
		const b = now - 10 * 3_600_000;
		const c = now - 5 * 3_600_000;
		expect(l.x(b) - l.x(a)).toBeCloseTo(2 * (l.x(c) - l.x(b)), 9);
		expect(l.x(now)).toBe(1600);
	});

	test("is monotonic everywhere and round-trips within 1 ms", () => {
		const now = 1_787_712_000_000;
		const l = lens({ now, focusStart: now - 24 * 3_600_000, focusEnd: now, width: 1600, minPxPerHour: 8 });
		const times = [now - 400 * 3_600_000, now - 30 * 3_600_000, now - 3_600_000, now, now + 3_600_000];
		const xs = times.map((t) => l.x(t));
		for (let i = 1; i < xs.length; i++) {
			expect(xs[i]).toBeGreaterThan(xs[i - 1]);
		}
		for (const t of times) {
			expect(Math.abs(l.t(l.x(t)) - t)).toBeLessThan(1);
		}
	});

	test("ticks use the manifesto labels and lie inside the width", () => {
		const now = 1_787_712_000_000;
		const l = lens({ now, focusStart: now - 30 * 24 * 3_600_000, focusEnd: now, width: 1600, minPxPerHour: 4 });
		const ticks = l.ticks();
		const labels = new Set(["now", "1h", "3h", "12h", "1d", "3d", "1w", "2w"]);
		expect(ticks.length).toBeGreaterThan(0);
		for (const tick of ticks) {
			expect(labels.has(tick.label)).toBe(true);
			const pos = l.x(tick.t);
			expect(pos).toBeGreaterThanOrEqual(0);
			expect(pos).toBeLessThanOrEqual(1600);
		}
		expect(ticks[ticks.length - 1]?.label).toBe("now");
	});
});
