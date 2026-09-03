// gen-depth.mjs — canvas direction DEPTH: recency as depth.
//
// The newest work sits in the foreground, close to the workspace leader, at
// full size and full contrast. Older work recedes: smaller, dimmer, further
// out. Nothing is hidden; the old is simply behind.
//
// Design working file. Nothing here ships as app code.

import { readFileSync, writeFileSync } from "node:fs";
import { esc, icon, sigil, stateClass, stateColor } from "./lib.mjs";

const here = (name) => new URL(`./${name}`, import.meta.url);
const data = JSON.parse(readFileSync(here("dataset.json"), "utf8"));
const shell = readFileSync(here("shell.partial.html"), "utf8");

/* ------------------------------------------------------------------ *
 * Geometry constants
 * ------------------------------------------------------------------ */

const ROW_H = 26; // completed / blocked / failed row
const RUN_H = 42; // running row (name+task row, then the activity line)
const GAP = 6; // vertical rhythm between rows
const LEAD_GAP = 14; // lead card bottom -> first row
const ROW_X = 22; // rows are indented from the group origin
const TRUNK_X = 16; // trunk edge sits 6px left of the row edge
const GROUP_W = 342; // ROW_X + the 320px row cap
const LEAD_W = 236;
const LEAD_W_WIDE = 296; // leads carrying a long blocked question
const LEAD_H = 94;
const LEAD_H_ATTN = 114;
const LEAD_H_SELF = 76; // mission 11: the workspace leader is the lead
const CHIP_H = 22;

// The workspace leader: fixed focal node, never scaled.
const LEADER = { x: 640, y: 500, w: 236, h: 74 };
const LCX = LEADER.x + LEADER.w / 2;
const LCY = LEADER.y + LEADER.h / 2;

// Visible band (navigator left, chat right).
const BAND = { x0: 280, x1: 1174, y0: 70, y1: 1000 };

// Depth tiers. Attention (Blocked / Failed / Merged · not closed) promotes a
// mission one tier closer than its age would put it.
const TIERS = {
  1: { s: 1.0, o: 1.0, dMin: 175, dMax: 380, cap: 8 },
  2: { s: 0.94, o: 0.95, dMin: 230, dMax: 480, cap: 5 },
  3: { s: 0.86, o: 0.82, dMin: 340, dMax: 580, cap: 2 },
  4: { s: 0.76, o: 0.62, dMin: 400, dMax: 740, cap: 1 },
};

const AGE_TIER = {
  "14": 1, "13": 1, "12": 1,
  "11": 2, "10": 2,
  "09": 3, "08": 3, "07": 3, "06": 3,
  "05": 4, "04": 4, "03": 4, "02": 4, "01": 4,
};

// Where each mission wants to sit, in degrees (0 = right, 90 = down). Seeds
// only — the packer moves them. Chosen so the composition is a desk, not a
// radial fan.
const SEED_ANGLE = {
  "14": -74, "13": 38, "12": 126,
  "11": 186, "10": 62, "09": -34,
  "08": 14, "07": 150, "06": -104, "02": -152, "01": 164,
  "05": -168, "04": 116, "03": 176,
};

/* ------------------------------------------------------------------ *
 * Per-mission model: rows, protected bands, group height
 * ------------------------------------------------------------------ */

const PRIORITY = { Blocked: 0, Failed: 1, Running: 2 };

function buildMission(m) {
  const baseTier = AGE_TIER[m.ordinal];
  const attn = typeof m.attention === "string" && m.attention.length > 0;
  const wide = attn && m.attention.length > 30;
  const leadW = wide ? LEAD_W_WIDE : LEAD_W;
  const leadH = m.leadIsWorkspaceLeader ? LEAD_H_SELF : attn ? LEAD_H_ATTN : LEAD_H;

  const priority = m.agents.filter((a) => a.state !== "Completed");
  priority.sort((a, b) => (PRIORITY[a.state] ?? 3) - (PRIORITY[b.state] ?? 3));
  const completed = m.agents.filter((a) => a.state === "Completed");
  const tier = attn && baseTier > 1 ? baseTier - 1 : baseTier;
  const shown = completed.slice(0, TIERS[tier].cap);
  const hidden = completed.length - shown.length;

  const rows = [];
  let y = leadH + LEAD_GAP;
  for (const agent of [...priority, ...shown]) {
    const h = agent.state === "Running" ? RUN_H : ROW_H;
    rows.push({ agent, y, h });
    y += h + GAP;
  }
  const chipY = hidden > 0 ? y : null;
  if (hidden > 0) y += CHIP_H + GAP;
  const groupH = y - GAP;

  // Nothing may occlude the lead card, the running/blocked/failed rows, or
  // the +N expander. Only the tail of the completed run may go behind a
  // nearer mission.
  const guardRows = priority.length > 0 ? priority.length : Math.min(1, rows.length);
  const protectedEnd = rows.length > 0
    ? rows[guardRows - 1].y + rows[guardRows - 1].h
    : leadH;

  return {
    m, attn, wide, leadW, leadH, rows, chipY, hidden, groupH, protectedEnd, tier,
    s: TIERS[tier].s,
    o: TIERS[tier].o,
  };
}

const groups = data.missions.map(buildMission);
const byOrdinal = new Map(groups.map((g) => [g.m.ordinal, g]));

// Depth order: far tiers paint first, near tiers paint over them.
const drawOrder = [...groups].sort((a, b) => (b.tier - a.tier) || (a.m.ordinal < b.m.ordinal ? -1 : 1));

/* ------------------------------------------------------------------ *
 * Packing: place each group so depth reads as distance, same-tier groups
 * never overlap, and no nearer group ever covers a lead card, a
 * running/blocked/failed row, or a +N chip.
 * ------------------------------------------------------------------ */

function mulberry32(a) {
  return function rnd() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20260903);

const ROOT = { x0: 0, y0: 0, x1: 1600, y1: 1000 };
// What a reader can actually see: the band, plus nothing under either panel.
const SEEN = { x0: 268, y0: 0, x1: BAND.x1, y1: 1000 };
const OBSTACLES = [
  { x: 0, y: 0, w: 1600, h: 66 }, // toolbar strip and title bar
  { x: 886, y: 978, w: 210, h: 20 }, // legend
];
// Blocked / failed / merged-not-closed missions must sit fully in the band.
const ATTENTION = new Set(["01", "02", "09", "12"]);

// Per tier: how badly a hidden pixel counts. Identity is never negotiable —
// every lead card stays in the band. Live rows may recede for the oldest
// tier only, and finished tails may recede or sit behind a nearer mission.
const W_HIDE_LEAD = 120;
const W_HIDE_LIVE = { 1: 30, 2: 24, 3: 8, 4: 2.5 };
const W_HIDE_TAIL = { 1: 1.6, 2: 1.2, 3: 0.5, 4: 0.15 };

function rect(x, y, w, h) {
  return { x, y, w, h };
}
function box(g, p) {
  return rect(p.x, p.y, GROUP_W * g.s, g.groupH * g.s);
}
function leadBox(g, p) {
  return rect(p.x, p.y, g.leadW * g.s, g.leadH * g.s);
}
// Running / blocked / failed rows: the live work.
function liveBox(g, p) {
  return rect(p.x, p.y + g.leadH * g.s, GROUP_W * g.s, (g.protectedEnd - g.leadH) * g.s);
}
function chipBox(g, p) {
  if (g.chipY === null) return null;
  return rect(p.x + ROW_X * g.s, p.y + (g.chipY - 3) * g.s, 300 * g.s, (CHIP_H + 6) * g.s);
}
function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return null;
  return { w, h, area: w * h };
}
function hiddenArea(r, region) {
  const seen = overlap(r, rect(region.x0, region.y0, region.x1 - region.x0, region.y1 - region.y0));
  return r.w * r.h - (seen ? seen.area : 0);
}

function cost(pos, detail) {
  let total = 0;
  const report = [];
  const note = (s2) => {
    if (detail) report.push(s2);
  };

  for (let i = 0; i < drawOrder.length; i += 1) {
    const g = drawOrder[i];
    const ord = g.m.ordinal;
    const p = pos[ord];
    const b = box(g, p);
    const lead = leadBox(g, p);
    const live = liveBox(g, p);
    const chip = chipBox(g, p);

    const ring = rect(LEADER.x - 8, LEADER.y - 8, LEADER.w + 16, LEADER.h + 16);
    const hitLeader = overlap(b, ring);
    if (hitLeader) {
      total += hitLeader.area * 60;
      note(ord + ' crowds the leader (' + Math.round(hitLeader.area) + 'px2)');
    }

    for (const ob of OBSTACLES) {
      const hg = overlap(lead, ob) || overlap(live, ob);
      if (hg) {
        total += hg.area * 30;
        note(ord + ' identity under the toolbar/legend');
      }
      const hb = overlap(b, ob);
      if (hb) total += hb.area * 4;
    }

    const hidLead = hiddenArea(lead, SEEN);
    if (hidLead > 1) {
      total += hidLead * W_HIDE_LEAD;
      note(ord + ' lead card off-band by ' + Math.round(hidLead) + 'px2');
    }
    const hidLive = hiddenArea(live, SEEN);
    if (hidLive > 1) {
      total += hidLive * W_HIDE_LIVE[g.tier];
      note(ord + ' live rows off-band by ' + Math.round(hidLive) + 'px2');
    }
    if (chip) {
      const hidChip = hiddenArea(chip, SEEN);
      if (hidChip > 1) {
        total += hidChip * 15;
        note(ord + ' +N chip off-band');
      }
    }
    const hidBox = hiddenArea(b, SEEN);
    total += hidBox * W_HIDE_TAIL[g.tier];
    total += hiddenArea(b, ROOT) * 0.6;
    if (ATTENTION.has(ord) && hidBox > 1) {
      total += hidBox * 60;
      note(ord + ' needs attention but sits ' + Math.round(hidBox) + 'px2 outside the band');
    }

    const t = TIERS[g.tier];
    const cx = lead.x + lead.w / 2;
    const cy = lead.y + lead.h / 2;
    const d = Math.hypot(cx - LCX, cy - LCY);
    const near = g.tier >= 3 ? 6 : 1.2;
    const far = g.tier >= 3 ? 0.06 : 0.9;
    if (d < t.dMin) total += (t.dMin - d) ** 2 * near;
    if (d > t.dMax) total += (d - t.dMax) ** 2 * far;

    for (let j = 0; j < i; j += 1) {
      const back = drawOrder[j];
      const bp = pos[back.m.ordinal];
      const hit = overlap(b, box(back, bp));
      if (!hit) continue;
      if (back.tier === g.tier) {
        total += hit.area * 25;
        note(ord + ' overlaps same-tier ' + back.m.ordinal + ' (' + Math.round(hit.area) + 'px2)');
        continue;
      }
      const onLead = overlap(b, leadBox(back, bp));
      if (onLead) {
        total += onLead.area * 40;
        note(ord + ' covers the lead card of ' + back.m.ordinal);
      }
      const onLive = overlap(b, liveBox(back, bp));
      if (onLive) {
        total += onLive.area * 25;
        note(ord + ' covers live rows of ' + back.m.ordinal + ' (' + Math.round(onLive.area) + 'px2)');
      }
      const backChip = chipBox(back, bp);
      const onChip = backChip && overlap(b, backChip);
      if (onChip) {
        total += onChip.area * 15;
        note(ord + ' covers the +N chip of ' + back.m.ordinal);
      }
      total += hit.area * 0.35;
    }

    for (let j = 0; j < i; j += 1) {
      const other = drawOrder[j];
      const ob2 = leadBox(other, pos[other.m.ordinal]);
      const dd = Math.hypot(cx - (ob2.x + ob2.w / 2), cy - (ob2.y + ob2.h / 2));
      if (dd < 175) total += (175 - dd) ** 2 * 0.8;
    }
  }

  return detail ? { total, report } : total;
}


// The foreground is composed by hand: the leader keeps its ring, the three
// newest missions hug it, and the three from today flank it. Everything else
// is packed around them below.
const FIXED = {
  // Composed by hand, front to back. The newest missions hug the leader; older
  // ones step outward, then slide behind the foreground, under the chat panel
  // and past the window edges. Every lead card keeps a readable corner.
  "14": { x: 540, y: 296 },
  "13": { x: 884, y: 700 },
  "12": { x: 540, y: 702 },
  "11": { x: 272, y: 500 },
  "10": { x: 272, y: 70 },
  "09": { x: 853, y: 70 },
  "08": { x: 1090, y: 282 },
  "07": { x: 1090, y: 455 },
  "06": { x: 884, y: 525 },
  "05": { x: 594, y: 578 },
  "04": { x: 10, y: 104 },
  "03": { x: 892, y: 282 },
  "02": { x: 596, y: 70 },
  "01": { x: 280, y: 897 },
};

function seed(spread) {
  const out = {};
  for (const g of groups) {
    if (FIXED[g.m.ordinal]) {
      out[g.m.ordinal] = { ...FIXED[g.m.ordinal] };
      continue;
    }
    const t = TIERS[g.tier];
    const jitter = (rnd() - 0.5) * spread;
    const a = ((SEED_ANGLE[g.m.ordinal] + jitter) * Math.PI) / 180;
    const d = t.dMin + rnd() * (t.dMax - t.dMin);
    out[g.m.ordinal] = {
      x: Math.round(LCX + Math.cos(a) * d - (g.leadW * g.s) / 2),
      y: Math.round(LCY + Math.sin(a) * d - (g.leadH * g.s) / 2),
    };
  }
  return out;
}

const free = groups.filter((g) => !FIXED[g.m.ordinal]);
let place = null;
let placeCost = Infinity;
for (let restart = 0; restart < (free.length === 0 ? 1 : 10); restart += 1) {
  let cur = seed(restart === 0 ? 0 : 90);
  let curCost = cost(cur);
  let localBest = { ...cur };
  let localBestCost = curCost;
  const ITER = free.length === 0 ? 0 : 150000;
  for (let step = 0; step < ITER; step += 1) {
    const frac = step / ITER;
    const temp = 4000 * Math.pow(0.00012, frac);
    const sigma = 130 * Math.pow(0.03, frac) + 2;
    const roll = rnd();
    const g = free[Math.floor(rnd() * free.length)];
    const key = g.m.ordinal;
    const prev = cur[key];
    let other = null;
    let prevOther = null;
    if (roll < 0.1) {
      // Swap two missions: lets a pair trade slots in one move.
      other = free[Math.floor(rnd() * free.length)];
      if (other === g) other = null;
    }
    if (other) {
      prevOther = cur[other.m.ordinal];
      cur[key] = { ...prevOther };
      cur[other.m.ordinal] = { ...prev };
    } else if (roll < 0.22) {
      const t = TIERS[g.tier];
      const a = rnd() * Math.PI * 2;
      const d = t.dMin + rnd() * (t.dMax - t.dMin);
      cur[key] = {
        x: Math.round(LCX + Math.cos(a) * d - (g.leadW * g.s) / 2),
        y: Math.round(LCY + Math.sin(a) * d - (g.leadH * g.s) / 2),
      };
    } else {
      const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * sigma;
      cur[key] = { x: Math.round(prev.x + gauss()), y: Math.round(prev.y + gauss()) };
    }
    const nextCost = cost(cur);
    if (nextCost <= curCost || rnd() < Math.exp((curCost - nextCost) / temp)) {
      curCost = nextCost;
      if (nextCost < localBestCost) {
        localBestCost = nextCost;
        localBest = { ...cur };
      }
    } else {
      cur[key] = prev;
      if (other) cur[other.m.ordinal] = prevOther;
    }
  }
  if (localBestCost < placeCost) {
    placeCost = localBestCost;
    place = localBest;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const violet = (alpha) => `rgba(153,133,245,${alpha.toFixed(2)})`;
const AMBER_EDGE = "rgba(245,173,71,0.6)";

function gx(g, localX) {
  return place[g.m.ordinal].x + localX * g.s;
}
function gy(g, localY) {
  return place[g.m.ordinal].y + localY * g.s;
}

// --- edges ----------------------------------------------------------

function anchorFromLeader(g) {
  const lb = leadBox(g, place[g.m.ordinal]);
  const above = lb.y + lb.h < LEADER.y - 8;
  // A group grows downward, so a mission sitting above the leader is reached
  // along its clear left channel instead of through its own stack.
  const p3 = above
    ? { x: lb.x, y: lb.y + lb.h / 2 }
    : {
        x: Math.max(lb.x, Math.min(LCX, lb.x + lb.w)),
        y: lb.y > LCY ? lb.y : lb.y + lb.h,
      };
  const p0 = {
    x: Math.max(LEADER.x, Math.min(p3.x, LEADER.x + LEADER.w)),
    y: Math.max(LEADER.y, Math.min(p3.y, LEADER.y + LEADER.h)),
  };
  if (p0.x > LEADER.x && p0.x < LEADER.x + LEADER.w) {
    p0.y = p3.y < LCY ? LEADER.y : LEADER.y + LEADER.h;
  }
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const c = Math.abs(dx) >= Math.abs(dy)
    ? [{ x: p0.x + dx * 0.45, y: p0.y }, { x: p3.x - dx * 0.45, y: p3.y }]
    : [{ x: p0.x, y: p0.y + dy * 0.45 }, { x: p3.x, y: p3.y - dy * 0.45 }];
  const r = (n) => Math.round(n * 10) / 10;
  return `M ${r(p0.x)} ${r(p0.y)} C ${r(c[0].x)} ${r(c[0].y)} ${r(c[1].x)} ${r(c[1].y)} ${r(p3.x)} ${r(p3.y)}`;
}

const edgeParts = [];
for (const g of drawOrder) {
  const isBlocked = g.m.state === "Blocked";
  const self = g.m.leadIsWorkspaceLeader;
  const stroke = isBlocked ? AMBER_EDGE : self ? violet(0.72) : violet(0.5 * g.o);
  const cls = isBlocked ? "edge edge-leader edge-blocked" : "edge edge-leader";
  const width = self ? ' stroke-width="1.8"' : "";
  edgeParts.push(
    `      <path class="${cls}" stroke="${stroke}"${width} d="${anchorFromLeader(g)}"></path>`,
  );
}
for (const g of drawOrder) {
  const anchors = g.rows.map((r) => r.y + r.h / 2);
  if (g.chipY !== null) anchors.push(g.chipY + CHIP_H / 2);
  if (anchors.length === 0) continue;
  const r = (n) => Math.round(n * 10) / 10;
  const trunkTop = gy(g, g.leadH);
  const trunkBottom = gy(g, anchors[anchors.length - 1]);
  const x = gx(g, TRUNK_X);
  edgeParts.push(
    `      <path class="edge" stroke="${violet(0.35 * g.o)}" d="M ${r(x)} ${r(trunkTop)} L ${r(x)} ${r(trunkBottom)}"></path>`,
  );
  const plain = [];
  const blocked = [];
  g.rows.forEach((row) => {
    const cy = r(gy(g, row.y + row.h / 2));
    const seg = `M ${r(x)} ${cy} L ${r(gx(g, ROW_X))} ${cy}`;
    (row.agent.state === "Blocked" ? blocked : plain).push(seg);
  });
  if (g.chipY !== null) {
    const cy = r(gy(g, g.chipY + CHIP_H / 2));
    plain.push(`M ${r(x)} ${cy} L ${r(gx(g, ROW_X))} ${cy}`);
  }
  if (plain.length > 0) {
    edgeParts.push(`      <path class="edge" stroke="${violet(0.35 * g.o)}" d="${plain.join(" ")}"></path>`);
  }
  if (blocked.length > 0) {
    edgeParts.push(`      <path class="edge edge-blocked" stroke="${AMBER_EDGE}" d="${blocked.join(" ")}"></path>`);
  }
}

// --- nodes ----------------------------------------------------------

function accessIcon(access) {
  return `<span class="access">${icon(access === "read-write" ? "pencil" : "eye", 12)}</span>`;
}

function rowNode(g, row) {
  const a = row.agent;
  const cls = `node-row ${a.state === "Running" ? "is-running" : a.state === "Blocked" ? "is-blocked" : a.state === "Failed" ? "is-failed" : "is-completed"}`;
  const style = `left: ${ROW_X}px; top: ${row.y}px;${a.state === "Running" ? ` min-height: ${RUN_H}px;` : ""}`;
  const activity = a.state === "Running" && a.activity
    ? `<span class="activity">${esc(a.activity)}</span>`
    : "";
  return [
    `        <div class="${cls}" style="${style}">`,
    `          ${sigil(a.name, a.hue, 12)}`,
    `          <span class="name">${esc(a.name)}</span>`,
    `          <span class="task">${esc(a.task)}</span>`,
    `          <span class="state" style="color: ${stateColor(a.state)};"><i></i>${esc(a.state)}</span>`,
    `          ${accessIcon(a.access)}`,
    ...(activity ? [`          ${activity}`] : []),
    `        </div>`,
  ].join("\n");
}

function attnBorder(state) {
  if (state === "Blocked") return "rgba(245,173,71,0.6)";
  if (state === "Failed") return "rgba(255,97,97,0.6)";
  return "rgba(138,179,255,0.6)"; // Merged · not closed
}

function leadCard(g) {
  const m = g.m;
  const border = g.attn
    ? ` border-color: ${attnBorder(m.state)};`
    : m.leadIsWorkspaceLeader
      ? " border-color: rgba(153,133,245,0.55);"
      : "";
  const style = `left: 0px; top: 0px; width: ${g.leadW}px; max-width: ${g.leadW}px; height: ${g.leadH}px;${border}`;
  const head = m.leadIsWorkspaceLeader
    ? `<span class="mono tnum lead-ord">${esc(m.ordinal)}</span><span class="lead-ord" style="font-weight: 500;">· led by ${esc(data.leader.name)}</span>`
    : `<span class="mono tnum lead-ord">${esc(m.ordinal)}</span>`;
  const out = [
    `        <div class="node node-lead" style="${style}">`,
    `          <div class="node-row">${head}<span style="flex: 1;"></span><span class="mono tnum lead-age">${esc(m.age)}</span></div>`,
    `          <div class="lead-name">${esc(m.name)}</div>`,
    `          <div class="node-state ${stateClass(m.state)}"><span class="state-dot"></span><span class="state-label">${esc(m.state)}</span></div>`,
  ];
  if (g.attn) {
    out.push(`          <div class="node-attn" style="white-space: nowrap;">${esc(m.attention)}</div>`);
  }
  if (m.lead) {
    out.push(
      `          <div class="node-row" style="gap: 6px;">${sigil(m.lead.name, m.lead.hue, 12)}<span style="font-size: 11px; font-weight: 600;">${esc(m.lead.name)}</span><span class="prov">${m.lead.provider === "Codex" ? "X" : "C"}</span>${accessIcon(m.lead.access)}<span style="font-size: 10px; font-weight: 500; color: var(--text-2); margin-left: auto;">${esc(m.lead.model)}</span></div>`,
    );
  }
  out.push(`        </div>`);
  return out.join("\n");
}

const groupParts = [];
for (const g of drawOrder) {
  const p = place[g.m.ordinal];
  groupParts.push(
    `      <div class="mission" style="position: absolute; left: ${p.x}px; top: ${p.y}px; width: ${GROUP_W}px; height: ${g.groupH}px; transform: scale(${g.s}); transform-origin: top left; opacity: ${g.o};">`,
  );
  groupParts.push(leadCard(g));
  for (const row of g.rows) groupParts.push(rowNode(g, row));
  if (g.chipY !== null) {
    groupParts.push(
      `        <span class="chip-more" style="position: absolute; left: ${ROW_X}px; top: ${g.chipY}px;">+${g.hidden} completed${icon("chevron-right", 12)}</span>`,
    );
  }
  groupParts.push(`      </div>`);
}

const leaderNode = [
  `      <div class="node node-leader" style="left: ${LEADER.x}px; top: ${LEADER.y}px;">`,
  `        <div class="node-row" style="gap: 12px;">`,
  `          <span class="leader-avatar">${icon("crown", 20)}</span>`,
  `          <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0;">`,
  `            <span class="leader-name">${esc(data.leader.name)}</span>`,
  `            <span class="leader-sub">Workspace leader</span>`,
  `          </div>`,
  `          <span class="chip-mode" style="margin-left: auto;">${esc(data.leader.mode)}</span>`,
  `        </div>`,
  `      </div>`,
].join("\n");

const legend =
  `      <div class="tnum" style="position: absolute; left: 890px; top: 982px; font-size: 10px; font-weight: 500; color: var(--text-2);">01 oldest · 14 newest · nearer is newer</div>`;

const canvas = [
  `    <div class="rowform" style="position: absolute; inset: 0;">`,
  `      <svg style="position: absolute; inset: 0; width: 1600px; height: 1000px;" aria-hidden="true">`,
  ...edgeParts,
  `      </svg>`,
  ...groupParts,
  leaderNode,
  legend,
  `    </div>`,
].join("\n");

const chrono = [
  `Recency`,
  `<span style="position: relative; display: inline-block; width: 96px; height: 2px; border-radius: 1px; background: rgba(255,255,255,0.17);">`,
  `<span style="position: absolute; right: 0px; top: -4px; width: 10px; height: 10px; border-radius: 50%; background: rgba(255,255,255,0.88);"></span>`,
  `</span>`,
  `<span style="font-size: 11px; font-weight: 600; color: var(--text-2);">now</span>`,
].join("");

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

const ROW_CSS = `
    /* --- depth direction: row nodes (scoped to .rowform so the shell's
       .node-row header inside cards is untouched) --- */
    .rowform .mission > .node-row { position: absolute; display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 10px 0 8px; border-radius: 8px; background: rgba(20,23,25,0.96); border: 1px solid rgba(255,255,255,0.10); white-space: nowrap; max-width: 320px; box-sizing: border-box; }
    .rowform .mission > .node-row.is-running { height: auto; padding: 5px 10px 5px 8px; display: grid; grid-template-columns: auto auto minmax(0,1fr) auto auto; grid-template-rows: auto auto; column-gap: 8px; row-gap: 2px; align-items: center; }
    .rowform .mission > .node-row .name { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.94); flex: none; }
    .rowform .mission > .node-row .task { font-size: 11px; font-weight: 400; color: rgba(255,255,255,0.72); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .rowform .mission > .node-row .state { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 600; flex: none; }
    .rowform .mission > .node-row .state i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: currentColor; }
    .rowform .mission > .node-row .activity { grid-column: 2 / -1; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; color: rgba(255,255,255,0.56); overflow: hidden; text-overflow: ellipsis; }
    .rowform .mission > .node-row .access { width: 12px; height: 12px; color: rgba(255,255,255,0.56); display: inline-flex; flex: none; }
    .rowform .mission > .node-row.is-blocked { border-color: rgba(245,173,71,0.5); }
    .rowform .mission > .node-row.is-failed { border-color: rgba(255,97,97,0.5); }
    .rowform .mission > .node-row.is-completed .name, .rowform .mission > .node-row.is-completed .task { opacity: 0.7; }
`;

if (!shell.includes("<!-- CANVAS_LAYER -->") || !shell.includes("<!-- CHRONO_CONTROL -->")) {
  throw new Error("shell.partial.html is missing a placeholder");
}

const html = shell
  .replace("    <!-- CANVAS_LAYER -->", canvas)
  .replace("<!-- CHRONO_CONTROL -->", chrono)
  .replace("\n    @media (prefers-reduced-motion: reduce)", `${ROW_CSS}\n    @media (prefers-reduced-motion: reduce)`);

writeFileSync(here("Depth.dc.html"), html);

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

const detail = cost(place, true);
const rowCount = groups.reduce((n, g) => n + g.rows.length, 0);
const chipCount = groups.filter((g) => g.chipY !== null).length;
console.log(`Depth.dc.html written — cost ${Math.round(detail.total)}`);
console.log(`nodes: ${rowCount} agent rows + ${groups.length} lead cards + ${chipCount} chips + 1 leader = ${rowCount + groups.length + chipCount + 1}`);
const inBand = [];
const bleeds = [];
for (const g of drawOrder) {
  const b = box(g, place[g.m.ordinal]);
  const out = hiddenArea(b, SEEN);
  const t = TIERS[g.tier];
  const lb = leadBox(g, place[g.m.ordinal]);
  const d = Math.round(Math.hypot(lb.x + lb.w / 2 - LCX, lb.y + lb.h / 2 - LCY));
  const line = `${g.m.ordinal} tier ${g.tier} s=${g.s} d=${d} (${t.dMin}-${t.dMax}) box ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`;
  if (out < 1) inBand.push(g.m.ordinal);
  else bleeds.push(`${g.m.ordinal}: ${Math.round(out)}px2 past the band`);
  console.log("  " + line);
}
console.log("fully inside the band: " + inBand.sort().join(", "));
for (const b of bleeds) console.log("  bleed " + b);
for (const line of detail.report) console.log("  ! " + line);
