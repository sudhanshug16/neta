// spine-layout.mjs — geometry + packer for the SPINE direction.
// Design working file. Nothing here ships as app code.

export const SPINE_Y = 500;
export const ROOT = { w: 1600, h: 1000 };
export const BAND = { x0: 280, x1: 1174 };

// The workspace leader sits at the right end of the spine and never moves.
export const LEADER = { x: 934, y: 464, w: 236, h: 74 };

export const ROW_H = 40; // two lines: identity + full task
export const RUN_H = 40;
export const GAP = 5;
export const LEAD_GAP = 10; // spine-side edge of the card -> first row
export const CHIP_H = 22;
export const ROW_W = 220;
export const TRUNK = 6; // trunk edge sits 6px left of the card / row edge
export const FOOT_W = ROW_W + TRUNK;
export const LEAD_W = 210;
export const LEAD_H = 74;
export const LEAD_H_ATTN = 104; // long attention note, wrapped to two lines
export const LEAD_H_ATTN1 = 92; // short attention note, one line
export const LEAD_H_SELF = 74; // mission 11: the workspace leader is the lead

// --- time axis -------------------------------------------------------
// Log-like: the recent hours take most of the width, a 9-day-old mission
// still lands on the artboard (partly under the navigator).
const A = 260;
const X_NOW = 890;
const X_OLD = 380;

export function parseAge(age) {
  const m = /^(\d+)([mhd])$/.exec(age.trim());
  if (!m) throw new Error(`unparseable age: ${age}`);
  const n = Number(m[1]);
  return m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 1440;
}

const f = (t) => Math.log(1 + t / A);
const K = (X_NOW - X_OLD) / f(12960);
export const xForAge = (mins) => X_NOW - K * f(mins);

export const TICKS = [
  ["now", 0], ["1h", 60], ["3h", 180], ["12h", 720],
  ["1d", 1440], ["3d", 4320], ["1w", 10080],
].map(([label, mins]) => ({ label, x: Math.round(xForAge(mins)) }));

// --- per-mission stack ----------------------------------------------

const PRIORITY = { Running: 0, Blocked: 1, Failed: 2 };

export function buildStack(m, cap) {
  const live = m.agents.filter((a) => a.state !== "Completed");
  live.sort((a, b) => (PRIORITY[a.state] ?? 3) - (PRIORITY[b.state] ?? 3));
  const completed = m.agents.filter((a) => a.state === "Completed");
  const shown = completed.slice(0, cap);
  const hidden = completed.length - shown.length;

  const items = [];
  let off = 0;
  for (const agent of [...live, ...shown]) {
    const h = agent.state === "Running" ? RUN_H : ROW_H;
    items.push({ agent, off, h });
    off += h + GAP;
  }
  const chipOff = hidden > 0 ? off : null;
  if (hidden > 0) off += CHIP_H + GAP;
  const stackH = Math.max(0, off - GAP);
  const liveH = live.length > 0
    ? items[live.length - 1].off + items[live.length - 1].h
    : 0;
  return { items, chipOff, hidden, stackH, liveH, liveCount: live.length };
}

export function missionShape(m) {
  const attn = typeof m.attention === "string" && m.attention.length > 0;
  const self = Boolean(m.leadIsWorkspaceLeader);
  const completed = m.agents.filter((a) => a.state === "Completed").length;
  return {
    m,
    attn,
    self,
    completed,
    maxCap: Math.min(8, completed),
    above: Number(m.ordinal) % 2 === 1,
    anchorX: Math.round(xForAge(parseAge(m.age))),
    leadW: LEAD_W,
    leadH: self ? LEAD_H_SELF
      : attn ? (m.attention.length > 34 ? LEAD_H_ATTN : LEAD_H_ATTN1)
        : LEAD_H,
    stacks: Array.from({ length: Math.min(8, completed) + 1 }, (_, c) => buildStack(m, c)),
  };
}

// --- geometry --------------------------------------------------------

const rect = (x, y, w, h) => ({ x, y, w, h });
function hit(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const out = (v, lo, hi) => Math.max(0, lo - v) + Math.max(0, v - hi);

const OBSTACLES = [
  rect(432, 0, 736, 76), // toolbar capsule
  rect(0, 0, 96, 48), // traffic lights
  rect(LEADER.x - 22, LEADER.y - 20, LEADER.w + 44, LEADER.h + 40), // leader ring
  rect(280, 444, 196, 34), // spine legend
];

export const IDEAL_DX = -100; // where the anchor wants to sit inside the card
// Three tiers per side. A card sits on one of them, so the composition reads
// as a comb along the spine instead of a scatter.
export const LANES = [84, 196, 308];
export const MIN_LANE = LANES[0];

export function frame(s, st, lane, left) {
  const cardTop = s.above ? SPINE_Y - lane - s.leadH : SPINE_Y + lane;
  const wrapTop = s.above ? cardTop - LEAD_GAP - st.stackH : cardTop;
  const cardLocalY = s.above ? st.stackH + LEAD_GAP : 0;
  const w = Math.max(s.leadW, ROW_W) + TRUNK;
  const full = rect(left - TRUNK, wrapTop, w, s.leadH + LEAD_GAP + st.stackH);
  const liveTop = s.above ? cardTop - LEAD_GAP - st.liveH : cardTop;
  const live = rect(left - TRUNK, liveTop, w, s.leadH + LEAD_GAP + st.liveH);
  const card = rect(left, cardTop, s.leadW, s.leadH);
  const chip = st.chipOff === null ? null : rect(
    left,
    wrapTop + (s.above ? st.stackH - st.chipOff - CHIP_H : s.leadH + LEAD_GAP + st.chipOff),
    150,
    CHIP_H,
  );
  const box = rect(full.x, Math.max(0, full.y), full.w, Math.min(ROOT.h, full.y + full.h) - Math.max(0, full.y));
  return { lane, left, cardTop, wrapTop, cardLocalY, full, live, card, chip, box, stack: st };
}


// --- packing: a fixed comb of four columns on each side --------------
//
// Four columns across the visible band, two missions deep in most of them.
// A mission keeps its own anchor on the time axis; the card is the nearest
// free slot to that anchor, joined to it by the drop edge. Column order is
// chronological, so left to right still reads oldest to newest.

const COL_X = [280, 508, 736, 964];
const PAD = 4;
const DEPTH_ABOVE = 500; // y 0 .. 500
const DEPTH_BELOW = 496; // y 500 .. 996

// ordinal: [column, slot (0 = nearest the spine), completed rows shown]
const SLOTS = {
  "01": [0, 1, 1], "03": [0, 0, 0],
  "05": [1, 1, 0], "07": [1, 0, 0],
  "11": [2, 0, 0],
  "09": [3, 0, 0], "13": [3, 1, 0],
  "02": [0, 0, 1], "04": [0, 1, 0],
  "06": [1, 0, 2], "08": [1, 1, 0],
  "10": [2, 0, 2],
  "12": [3, 0, 0], "14": [3, 1, 0],
};

export function pack(shapes) {
  const byOrd = new Map(shapes.map((s) => [s.m.ordinal, s]));
  const spill = [];
  const lanes = new Map();

  for (const [ord, [col, slot, cap]] of Object.entries(SLOTS)) {
    const s = byOrd.get(ord);
    let lane = MIN_LANE;
    if (slot > 0) {
      const near = Object.entries(SLOTS)
        .find(([o, v]) => v[0] === col && v[1] === slot - 1 && byOrd.get(o).above === s.above);
      const n = byOrd.get(near[0]);
      lane = MIN_LANE + n.leadH + LEAD_GAP + n.stacks[SLOTS[near[0]][2]].stackH + PAD;
    }
    lanes.set(ord, lane);
  }

  const frames = shapes.map((s) => {
    const [col, , cap] = SLOTS[s.m.ordinal];
    const lane = lanes.get(s.m.ordinal);
    const st = s.stacks[Math.min(cap, s.maxCap)];
    const depth = lane + s.leadH + LEAD_GAP + st.stackH;
    const limit = s.above ? DEPTH_ABOVE : DEPTH_BELOW;
    if (depth > limit) spill.push(`${s.m.ordinal} by ${Math.round(depth - limit)}px`);
    return frame(s, st, lane, COL_X[col]);
  });

  return { frames, spill };
}
