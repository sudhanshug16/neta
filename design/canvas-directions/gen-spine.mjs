// gen-spine.mjs — canvas direction SPINE: chronology as a spatial sequence.
//
// A soft horizontal time axis runs left from the workspace leader ("now").
// Every mission anchors to the spine at the moment it started; its lead card
// sits just off the spine and its agents hang away from it. Reading right to
// left is reading backwards in time.
//
// Design working file. Nothing here ships as app code.

import { readFileSync, writeFileSync } from "node:fs";
import { esc, icon, sigil, stateClass, stateColor } from "./lib.mjs";
import * as L from "./spine-layout.mjs";

const here = (name) => new URL(`./${name}`, import.meta.url);
const data = JSON.parse(readFileSync(here("dataset.json"), "utf8"));
const shell = readFileSync(here("shell.partial.html"), "utf8");

const shapes = data.missions.map(L.missionShape);
const packed = L.pack(shapes);
const place = new Map(shapes.map((s, i) => [s.m.ordinal, packed.frames[i]]));

const violet = (a) => `rgba(153,133,245,${a})`;
const AMBER = "rgba(245,173,71,0.6)";
const r1 = (n) => Math.round(n * 10) / 10;

const ATTN_COLOR = { Blocked: "#F5AD47", Failed: "#FF6161" };
const attnColor = (state) => ATTN_COLOR[state] ?? "#8AB3FF";

/* ---------------------------------------------------------------- *
 * Edges: the spine, the anchors, the drop to each lead, the trunks
 * ---------------------------------------------------------------- */

const edges = [];
const anchors = [];

edges.push(
  `        <line x1="16" y1="501.5" x2="1592" y2="501.5" stroke="${violet(0.06)}" stroke-width="2"></line>`,
  `        <line x1="16" y1="500.5" x2="1592" y2="500.5" stroke="rgba(255,255,255,0.14)" stroke-width="1"></line>`,
);
for (const t of L.TICKS) {
  edges.push(
    `        <line x1="${t.x}.5" y1="500" x2="${t.x}.5" y2="507" stroke="rgba(255,255,255,0.22)" stroke-width="1"></line>`,
  );
}

for (const s of shapes) {
  const fr = place.get(s.m.ordinal);
  const ax = s.anchorX;
  const ay = s.above ? L.SPINE_Y - 4 : L.SPINE_Y + 4;
  const ty = s.above ? fr.cardTop + s.leadH : fr.cardTop;
  const tx = Math.max(fr.left + 18, Math.min(ax, fr.left + s.leadW - 18));
  const my = r1((ay + ty) / 2);
  const d = Math.abs(tx - ax) < 1
    ? `M ${ax} ${ay} L ${ax} ${r1(ty)}`
    : `M ${ax} ${ay} C ${ax} ${my} ${tx} ${my} ${tx} ${r1(ty)}`;
  const blocked = s.m.state === "Blocked";
  edges.push(
    `        <path class="edge${blocked ? " edge-blocked" : ""}" stroke="${blocked ? AMBER : violet(0.42)}" d="${d}"></path>`,
  );

  if (s.self) {
    const lx = L.LEADER.x;
    const ly = L.LEADER.y + L.LEADER.h / 2;
    edges.push(
      `        <path class="edge edge-leader" stroke="${violet(0.75)}" stroke-width="1.8" d="M ${ax} ${L.SPINE_Y} C ${ax + 110} ${L.SPINE_Y - 26} ${lx - 110} ${ly - 26} ${lx} ${ly}"></path>`,
    );
  }

  // trunk + stubs
  const items = [...fr.stack.items];
  const tops = items.map((it) => ({ y: rowCenter(s, fr, it.off, it.h), blocked: it.agent.state === "Blocked" }));
  if (fr.stack.chipOff !== null) {
    tops.push({ y: rowCenter(s, fr, fr.stack.chipOff, L.CHIP_H), blocked: false });
  }
  if (tops.length > 0) {
    const trunkX = fr.left - L.TRUNK + 0.5;
    const near = s.above ? fr.cardTop - 2 : fr.cardTop + s.leadH + 2;
    const far = tops.reduce((acc, t) => (s.above ? Math.min(acc, t.y) : Math.max(acc, t.y)), near);
    edges.push(
      `        <path class="edge" stroke="${violet(0.3)}" d="M ${trunkX} ${r1(near)} L ${trunkX} ${r1(far)}"></path>`,
    );
    const plain = [];
    const dashed = [];
    for (const t of tops) {
      const seg = `M ${trunkX} ${r1(t.y)} L ${fr.left} ${r1(t.y)}`;
      (t.blocked ? dashed : plain).push(seg);
    }
    if (plain.length > 0) {
      edges.push(`        <path class="edge" stroke="${violet(0.3)}" d="${plain.join(" ")}"></path>`);
    }
    if (dashed.length > 0) {
      edges.push(`        <path class="edge edge-blocked" stroke="${AMBER}" d="${dashed.join(" ")}"></path>`);
    }
  }

  anchors.push(
    `        <circle cx="${ax}" cy="${L.SPINE_Y}" r="4" fill="${stateColor(s.m.state)}" stroke="#0E0F13" stroke-width="1"></circle>`,
  );
}

function localY(s, fr, off, h) {
  return s.above
    ? fr.stack.stackH - off - h
    : s.leadH + L.LEAD_GAP + off;
}
function rowCenter(s, fr, off, h) {
  return fr.wrapTop + localY(s, fr, off, h) + h / 2;
}

/* ---------------------------------------------------------------- *
 * Nodes
 * ---------------------------------------------------------------- */

const accessIcon = (access) =>
  `<span class="access">${icon(access === "read-write" ? "pencil" : "eye", 12)}</span>`;

function rowNode(s, fr, it) {
  const a = it.agent;
  const kind = a.state === "Running" ? "is-running"
    : a.state === "Blocked" ? "is-blocked"
      : a.state === "Failed" ? "is-failed" : "is-completed";
  const top = localY(s, fr, it.off, it.h);
  return [
    `        <div class="node-row ${kind}" style="left: 0px; top: ${top}px;">`,
    `          ${sigil(a.name, a.hue, 12)}`,
    `          <span class="name">${esc(a.name)}</span>`,
    `          <span class="state" style="color: ${stateColor(a.state)};"><i></i>${esc(a.state)}</span>`,
    `          ${accessIcon(a.access)}`,
    `          <span class="task">${esc(a.task)}</span>`,
    `        </div>`,
  ].join("\n");
}

function leadCard(s, fr) {
  const m = s.m;
  const border = s.attn
    ? ` border-color: ${attnColor(m.state)}99;`
    : s.self ? ` border-color: ${violet(0.55)};` : "";
  const head = s.self
    ? `<span class="mono tnum lead-ord">${esc(m.ordinal)}</span><span class="lead-ord" style="font-weight: 500;">· led by ${esc(data.leader.name)}</span>`
    : `<span class="mono tnum lead-ord">${esc(m.ordinal)}</span>${sigil(m.lead.name, m.lead.hue, 12)}<span style="font-size: 11px; font-weight: 600;">${esc(m.lead.name)}</span><span class="prov">${m.lead.provider === "Codex" ? "X" : "C"}</span>${accessIcon(m.lead.access)}`;
  const out = [
    `        <div class="node node-lead" style="left: 0px; top: ${fr.cardLocalY}px; width: ${s.leadW}px; max-width: ${s.leadW}px; height: ${s.leadH}px;${border}">`,
    `          <div class="node-row" style="gap: 6px;">${head}<span style="flex: 1;"></span><span class="mono tnum lead-age">${esc(m.age)}</span></div>`,
    `          <div class="lead-name">${esc(m.name)}</div>`,
    `          <div class="node-state ${stateClass(m.state)}"><span class="state-dot"></span><span class="state-label">${esc(m.state)}</span></div>`,
  ];
  if (s.attn) {
    out.push(
      `          <div class="node-attn" style="color: ${attnColor(m.state)};">${esc(m.attention)}</div>`,
    );
  }
  out.push(`        </div>`);
  return out.join("\n");
}

const missionParts = [];
for (const s of shapes) {
  const fr = place.get(s.m.ordinal);
  const h = s.leadH + L.LEAD_GAP + fr.stack.stackH;
  missionParts.push(
    `      <div class="mission" style="position: absolute; left: ${fr.left}px; top: ${fr.wrapTop}px; width: ${L.ROW_W}px; height: ${h}px;">`,
    leadCard(s, fr),
  );
  for (const it of fr.stack.items) missionParts.push(rowNode(s, fr, it));
  if (fr.stack.chipOff !== null) {
    const top = localY(s, fr, fr.stack.chipOff, L.CHIP_H);
    missionParts.push(
      `        <span class="chip-more" style="position: absolute; left: 0px; top: ${top}px;">+${fr.stack.hidden} completed${icon("chevron-right", 12)}</span>`,
    );
  }
  missionParts.push(`      </div>`);
}

const tickLabels = L.TICKS.map((t) =>
  `      <div class="mono tnum" style="position: absolute; left: ${t.x - 24}px; top: 510px; width: 48px; text-align: center; font-size: 10px; font-weight: 500; color: var(--text-2);">${t.label}</div>`,
);

const leaderNode = [
  `      <div class="node node-leader" style="left: ${L.LEADER.x}px; top: ${L.LEADER.y}px;">`,
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
  `      <div class="tnum" style="position: absolute; left: 288px; top: 452px; font-size: 10px; font-weight: 500; color: var(--text-2);">01 oldest · 14 newest</div>`;

const canvas = [
  `    <div class="rowform" style="position: absolute; inset: 0;">`,
  `      <svg style="position: absolute; inset: 0; width: 1600px; height: 1000px; overflow: visible;" aria-hidden="true">`,
  ...edges,
  ...anchors,
  `      </svg>`,
  ...missionParts,
  leaderNode,
  ...tickLabels,
  legend,
  `    </div>`,
].join("\n");

const seg = (label, on) =>
  `<span style="padding: 3px 9px; border-radius: 6px; font-size: 11px; font-weight: 600; ${on ? "background: rgba(255,255,255,0.075); color: rgba(255,255,255,0.94);" : "color: var(--text-2);"}">${label}</span>`;
const chrono = [
  `Time`,
  `<span style="display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 8px; background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.06);">`,
  seg("Linear", false),
  seg("Log", true),
  `</span>`,
].join("");

const ROW_CSS = `
    /* --- spine direction: row nodes (scoped to .rowform so the shell's
       .node-row header inside cards is untouched) --- */
    .rowform .mission > .node-row { position: absolute; display: grid; grid-template-columns: auto minmax(0,1fr) auto auto; grid-template-rows: auto auto; column-gap: 8px; row-gap: 1px; align-items: center; height: ${L.ROW_H}px; padding: 4px 10px 5px 8px; border-radius: 8px; background: rgba(20,23,25,0.96); border: 1px solid rgba(255,255,255,0.10); width: ${L.ROW_W}px; box-sizing: border-box; }
    .rowform .mission > .node-row .name { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.94); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rowform .mission > .node-row .task { grid-column: 2 / -1; font-size: 11px; font-weight: 400; line-height: 1.2; color: rgba(255,255,255,0.78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rowform .mission > .node-row .state { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 600; flex: none; white-space: nowrap; }
    .rowform .mission > .node-row .state i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: currentColor; }
    .rowform .mission > .node-row .access { width: 12px; height: 12px; color: rgba(255,255,255,0.56); display: inline-flex; flex: none; }
    .rowform .mission > .node-row.is-blocked { border-color: rgba(245,173,71,0.5); }
    .rowform .mission > .node-row.is-failed { border-color: rgba(255,97,97,0.5); }
    .rowform .mission > .node-row.is-completed .name, .rowform .mission > .node-row.is-completed .task { opacity: 0.72; }
`;

if (!shell.includes("<!-- CANVAS_LAYER -->") || !shell.includes("<!-- CHRONO_CONTROL -->")) {
  throw new Error("shell.partial.html is missing a placeholder");
}

const html = shell
  .replace("    <!-- CANVAS_LAYER -->", canvas)
  .replace("<!-- CHRONO_CONTROL -->", chrono)
  .replace("\n    @media (prefers-reduced-motion: reduce)", `${ROW_CSS}\n    @media (prefers-reduced-motion: reduce)`);

writeFileSync(here("Main.dc.html"), html);

/* ---------------------------------------------------------------- *
 * Checks
 * ---------------------------------------------------------------- */

const tag = (name) => [
  (html.match(new RegExp(`<${name}[\\s>]`, "g")) || []).length,
  (html.match(new RegExp(`</${name}>`, "g")) || []).length,
];
for (const name of ["div", "span", "svg"]) {
  const [open, close] = tag(name);
  if (open !== close) throw new Error(`unbalanced <${name}>: ${open} open, ${close} close`);
  console.log(`  ${name}: ${open} open / ${close} close`);
}

let rows = 0;
let chips = 0;
const inBand = [];
const bleeding = [];
for (const s of shapes) {
  const fr = place.get(s.m.ordinal);
  rows += fr.stack.items.length;
  if (fr.stack.chipOff !== null) chips += 1;
  const cardY = fr.wrapTop + fr.cardLocalY;
  if (fr.left < 0 || fr.left + s.leadW > 1600 || cardY < 0 || cardY + s.leadH > 1000) {
    throw new Error(`lead ${s.m.ordinal} outside the root at ${fr.left},${cardY}`);
  }
  const ok = fr.left >= L.BAND.x0 && fr.left + s.leadW <= L.BAND.x1;
  (ok ? inBand : bleeding).push(s.m.ordinal);
  console.log(
    `  ${s.m.ordinal} anchor ${s.anchorX} ${s.above ? "above" : "below"} lane ${fr.lane} card ${fr.left},${cardY} ${s.leadW}x${s.leadH} cap ${fr.stack.items.length - fr.stack.liveCount} rows ${fr.stack.items.length}${fr.stack.chipOff !== null ? ` +${fr.stack.hidden}` : ""} stackTop ${Math.round(fr.wrapTop)}`,
  );
}
console.log(`Main.dc.html written — ${rows} agent rows + ${shapes.length} lead cards + ${chips} chips + 1 leader = ${rows + shapes.length + chips + 1} nodes`);
console.log(`spill past the edge: ${packed.spill.join(", ") || "none"}`);
console.log(`lead cards fully inside x 280-1174: ${inBand.join(", ")}`);
console.log(`lead cards crossing the band edge: ${bleeding.join(", ") || "none"}`);

const ov = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : null;
};
for (let i = 0; i < shapes.length; i += 1) {
  for (let j = i + 1; j < shapes.length; j += 1) {
    const a = packed.frames[i];
    const b = packed.frames[j];
    const hitBox = ov(a.box, b.box);
    if (!hitBox) continue;
    const kind = ov(a.card, b.card) ? "CARD/CARD" : ov(a.card, b.box) || ov(a.box, b.card) ? "card/stack" : "stack/stack";
    console.log(`  overlap ${shapes[i].m.ordinal}-${shapes[j].m.ordinal} ${kind} ${hitBox.w}x${hitBox.h}`);
  }
}
