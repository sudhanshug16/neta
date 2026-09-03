// type-layout.mjs — geometry for the TYPE direction.
//
// No cards: every mission is typeset directly on the ground. This module owns
// the metrics, the per-mission row model, and the placement of the two reading
// columns, so gen-type.mjs can stay a renderer.
//
// Design working file. Nothing here ships as app code.

export const M = {
  PAD: 6, // horizontal padding inside a hit target
  ORD_W: 46, // the ordinal numeral's box, so names align down a column
  ORD_GAP: 12,
  HEAD_H: 44, // mission header hit target (>= 44px)
  ATTN_H: 16, // extra line for a blocked question / failed check / merged note
  HEAD_GAP: 6,
  ROW_H: 24, // agent line
  RUN_H: 34, // agent line + activity line
  INDENT: 10, // agent lines sit just inside the ordinal
  TASK_CAP: 228, // task column cap (under 300 so both columns stay in band)
  NAME_W: 64,
  STATE_W: 72,
  GAP: 8, // column gap inside an agent line
  GAP_A: 6, // older half: set tight
  GAP_B: 8, // newer half

  COL_A: 280,
  COL_B: 732,
  META_W: 300, // header text column (name + status line)
  Y0: 56,
  LEADER: { x: 940, y: 500, w: 178, h: 58 },
  RULER_Y: 888, // the time ruler gets a reserved band across both columns
  RULER_BAND: { y0: 878, y1: 906 },
};

// The agent line is a fixed five-column grid; this is its total width.
export const LINE_W =
  M.PAD * 2 + 12 + M.NAME_W + M.TASK_CAP + M.STATE_W + 12 + M.GAP * 4;

// Rough text metrics. Only used for overlap checks and the fit report.
const w16 = (s) => s.length * 8.05; // mission name, 16/600
const w10u = (s) => s.length * 7.0; // status line, 10/600 uppercase +0.08em
const w11 = (s) => s.length * 5.9; // attention line, 11/400
const wChip = (s) => 30 + s.length * 5.9;
const wMono = (s) => s.length * 6.62;

// The ordinal grows with recency: the newest work is literally the largest
// thing on the canvas after the leader.
export function ordSize(ordinal) {
  const n = Number(ordinal);
  if (n >= 10) return 34;
  if (n >= 6) return 30;
  return 26;
}

// How many finished agents each mission spells out before folding the rest
// into its chip. Detail, like scale, grows with recency.
export function completedCap(ordinal) {
  return Number(ordinal) >= 13 ? 1 : 0;
}

const PRIORITY = { Running: 0, Blocked: 1, Failed: 2 };

export function buildBlocks(data) {
  return data.missions.map((m) => {
    const live = m.agents.filter((a) => a.state !== "Completed");
    live.sort((a, b) => (PRIORITY[a.state] ?? 3) - (PRIORITY[b.state] ?? 3));
    const done = m.agents.filter((a) => a.state === "Completed");
    const shown = done.slice(0, completedCap(m.ordinal));
    const hidden = done.length - shown.length;
    const rows = [...live, ...shown];

    const attn = typeof m.attention === "string" && m.attention.length > 0;
    const leadName = m.leadIsWorkspaceLeader ? data.leader.name : m.lead.name;
    const short = m.state;
    const sub = `${short} · ${m.age} · led by ${leadName}`.toUpperCase();
    const chip = hidden > 0 ? `+${hidden} completed` : null;

    let h = M.HEAD_H + (attn ? M.ATTN_H : 0);
    let lines = 0;
    for (const a of rows) lines += a.state === "Running" ? M.RUN_H : M.ROW_H;
    if (lines > 0) h += M.HEAD_GAP + lines;

    const taskW = Math.min(
      M.TASK_CAP,
      Math.max(0, ...rows.map((a) => wMono(a.task))),
    );
    const metaW = Math.min(M.META_W, Math.max(w16(m.name), w10u(sub)));
    const headW =
      M.PAD * 2 + M.ORD_W + M.ORD_GAP + metaW + (chip ? 10 + wChip(chip) : 0);
    const lineW = rows.length > 0
      ? M.INDENT + M.PAD * 2 + 12 + M.NAME_W + taskW + M.STATE_W + 12 + M.GAP * 4
      : 0;
    const attnW = attn ? M.INDENT + M.PAD * 2 + w11(m.attention) : 0;

    return {
      m,
      rows,
      chip,
      hidden,
      attn,
      sub,
      ord: m.ordinal,
      size: ordSize(m.ordinal),
      h,
      w: Math.round(Math.max(headW, lineW, attnW)),
      headW: Math.round(headW),
      x: 0,
      y: 0,
    };
  });
}

// Two reading columns. Column A is the older half, starting high on the left;
// column B is the newer half, stepping right and down, and it opens a clearing
// where the workspace leader sits.
export function place(blocks, split = 9) {
  const byOrd = new Map(blocks.map((b) => [b.ord, b]));
  const order = blocks.map((b) => b.ord).sort();
  const colA = order.slice(0, split).map((o) => byOrd.get(o));
  const colB = order.slice(split).map((o) => byOrd.get(o));
  const L = M.LEADER;
  const clear = { y0: L.y - 12, y1: L.y + L.h + 12 };

  const stack = (col, x, gap, avoid) => {
    let y = M.Y0;
    for (const b of col) {
      for (const a of avoid) {
        if (y < a.y1 && y + b.h > a.y0) y = a.y1;
      }
      b.x = x;
      b.y = y;
      y += b.h + gap;
    }
  };
  stack(colA, M.COL_A, M.GAP_A, [M.RULER_BAND]);
  stack(colB, M.COL_B, M.GAP_B, [clear, M.RULER_BAND]);
  return { colA, colB };
}

export function fitReport(blocks) {
  const notes = [];
  const inBand = [];
  for (const b of blocks) {
    if (b.y + M.HEAD_H > 1000 || b.y < 0 || b.x < 0 || b.x + b.w > 1600) {
      notes.push(`${b.ord}: header outside the root (${b.x},${b.y} ${b.w}x${b.h})`);
    }
    if (b.x >= 280 && b.x + b.w <= 1174 && b.y + b.h <= 1000) inBand.push(b.ord);
    else if (b.x >= 280 && b.x + b.w <= 1174) inBand.push(`${b.ord}*`);
  }
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i];
      const c = blocks[j];
      const ow = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x);
      const oh = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y);
      if (ow > 0 && oh > 0) notes.push(`${a.ord} overlaps ${c.ord} (${ow}x${oh})`);
    }
  }
  const L = M.LEADER;
  for (const b of blocks) {
    const ow = Math.min(b.x + b.w, L.x + L.w) - Math.max(b.x, L.x);
    const oh = Math.min(b.y + b.h, L.y + L.h) - Math.max(b.y, L.y);
    if (ow > 0 && oh > 0) notes.push(`${b.ord} overlaps the leader (${ow}x${oh})`);
  }
  return { notes, inBand };
}
