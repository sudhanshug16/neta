// gen-type.mjs — canvas direction TYPE: the text is the node.
//
// No cards, no containers. Missions and agents are typeset straight onto the
// dark ground like a control-room readout: the ordinal numeral carries the
// state colour and grows with recency, the mission name and status line sit
// beside it, and the agents run underneath as a rule-less mono table. Every
// mission header and every agent line is still a hit target; hairline edges
// tie each mission back to the workspace leader.
//
// Design working file. Nothing here ships as app code.

import { readFileSync, writeFileSync } from "node:fs";
import { esc, icon, sigil, stateColor } from "./lib.mjs";
import { M, buildBlocks, place, fitReport } from "./type-layout.mjs";

const here = (name) => new URL(`./${name}`, import.meta.url);
const data = JSON.parse(readFileSync(here("dataset.json"), "utf8"));
const shell = readFileSync(here("shell.partial.html"), "utf8");

const blocks = buildBlocks(data);
place(blocks, 9);
const L = M.LEADER;

// state colour at 85%, for the numerals
function dim(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const r1 = (n) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ *
 * Edges: leader -> each mission's ordinal
 * ------------------------------------------------------------------ */

const edges = [];
for (const b of blocks) {
  const tx = b.x + M.PAD + M.ORD_W;
  const ty = b.y + 22 + b.size * 0.36; // the numeral's right baseline point
  const lx = L.x;
  const ly = L.y + L.h / 2;
  const dx = lx - tx;
  const d = `M ${lx} ${r1(ly)} C ${r1(lx - dx * 0.45)} ${r1(ly)} ${r1(tx + dx * 0.45)} ${r1(ty)} ${r1(tx)} ${r1(ty)}`;
  const self = b.m.leadIsWorkspaceLeader;
  const blocked = b.m.state === "Blocked";
  const stroke = blocked
    ? "rgba(245,173,71,0.5)"
    : self
      ? "rgba(153,133,245,0.72)"
      : "rgba(153,133,245,0.30)";
  const dash = blocked ? ' stroke-dasharray="5 6"' : "";
  edges.push(
    `        <path d="${d}" fill="none" stroke="${stroke}" stroke-width="${self ? 2 : 1}" stroke-linecap="round"${dash}></path>`,
  );
}

/* ------------------------------------------------------------------ *
 * Time ruler: one hairline, seven labels, one tick per mission
 * ------------------------------------------------------------------ */

const RX0 = 300;
const RX1 = 1150;
const RY = M.RULER_Y;
const MARKS = [
  { label: "9d", m: 12960 },
  { label: "1w", m: 10080 },
  { label: "3d", m: 4320 },
  { label: "1d", m: 1440 },
  { label: "6h", m: 360 },
  { label: "1h", m: 60 },
  { label: "now", m: 0 },
];
const step = (RX1 - RX0) / (MARKS.length - 1);
MARKS.forEach((mk, i) => {
  mk.x = RX0 + i * step;
});
// Piecewise over the labelled stops, so a mission's tick lands where its age
// reads on the ruler rather than on a raw linear scale.
function timeX(minutes) {
  const v = Math.log(1 + Math.max(0, minutes));
  for (let i = 0; i < MARKS.length - 1; i += 1) {
    const a = Math.log(1 + MARKS[i].m);
    const b = Math.log(1 + MARKS[i + 1].m);
    if (v <= a && v >= b) {
      const t = (a - v) / (a - b);
      return MARKS[i].x + t * step;
    }
  }
  return v > Math.log(1 + MARKS[0].m) ? RX0 : RX1;
}

const ruler = [
  `        <path d="M ${RX0} ${RY} L ${RX1} ${RY}" stroke="rgba(255,255,255,0.10)" stroke-width="1" fill="none"></path>`,
];
for (const b of blocks) {
  const x = r1(timeX(b.m.startedMinutesAgo));
  ruler.push(
    `        <path d="M ${x} ${RY - 4} L ${x} ${RY}" stroke="${stateColor(b.m.state)}" stroke-width="1.5" fill="none"></path>`,
  );
}
const rulerLabels = MARKS.map(
  (mk) =>
    `      <span class="truler-tick" style="left: ${Math.round(mk.x)}px; top: ${RY + 6}px;">${esc(mk.label)}</span>`,
).join("\n");

/* ------------------------------------------------------------------ *
 * Missions
 * ------------------------------------------------------------------ */

function accessGlyph(access) {
  return `<span class="tac">${icon(access === "read-write" ? "pencil" : "eye", 12)}</span>`;
}

function lineOf(a) {
  const run = a.state === "Running";
  const out = [
    `          <div class="tline${run ? " is-run" : ""}">`,
    `            <span class="tsig">${sigil(a.name, a.hue, 12)}</span>`,
    `            <span class="tnm">${esc(a.name)}</span>`,
    `            <span class="ttask">${esc(a.task)}</span>`,
    `            <span class="tst" style="color: ${stateColor(a.state)};">${esc(a.state)}</span>`,
    `            ${accessGlyph(a.access)}`,
  ];
  if (run && a.activity) out.push(`            <span class="tactv">${esc(a.activity)}</span>`);
  out.push(`          </div>`);
  return out.join("\n");
}

const missionParts = [];
for (const b of blocks) {
  const c = stateColor(b.m.state);
  const out = [
    `      <div class="tmission" style="left: ${b.x}px; top: ${b.y}px; width: ${b.w}px;">`,
    `        <div class="thead">`,
    `          <span class="tord" style="font-size: ${b.size}px; color: ${dim(c, 0.85)};">${esc(b.ord)}</span>`,
    `          <span class="tmeta">`,
    `            <span class="tname">${esc(b.m.name)}</span>`,
    `            <span class="tsub" style="color: ${c};">${esc(b.sub)}</span>`,
    `          </span>`,
  ];
  if (b.chip) {
    out.push(
      `          <span class="chip-more">${esc(b.chip)}${icon("chevron-right", 12)}</span>`,
    );
  }
  out.push(`        </div>`);
  if (b.attn) {
    out.push(`        <div class="tattn" style="color: ${c};">${esc(b.m.attention)}</div>`);
  }
  if (b.rows.length > 0) {
    out.push(`        <div class="tlines">`);
    for (const a of b.rows) out.push(lineOf(a));
    out.push(`        </div>`);
  }
  out.push(`      </div>`);
  missionParts.push(out.join("\n"));
}

const leaderNode = [
  `      <div class="tleader" style="left: ${L.x}px; top: ${L.y}px;">`,
  `        <span class="tlav">${icon("crown", 20)}</span>`,
  `        <span class="tlmeta">`,
  `          <span class="tlname">${esc(data.leader.name)}</span>`,
  `          <span class="tlsub">Workspace leader · ${esc(data.leader.mode)}</span>`,
  `        </span>`,
  `      </div>`,
].join("\n");

const canvas = [
  `    <div class="typeform" style="position: absolute; inset: 0;">`,
  `      <svg style="position: absolute; inset: 0; width: 1600px; height: 1000px;" aria-hidden="true">`,
  ...edges,
  ...ruler,
  `      </svg>`,
  ...missionParts,
  leaderNode,
  rulerLabels,
  `    </div>`,
].join("\n");

const chrono = `Order · Started${icon("chevron-down", 12)}`;

/* ------------------------------------------------------------------ *
 * Styles — all scoped to .typeform; no unscoped .node-row rule.
 * ------------------------------------------------------------------ */

const CSS = `
    /* --- type direction: the text is the node --- */
    .typeform .tmission { position: absolute; display: flex; flex-direction: column; }
    .typeform .thead { display: flex; align-items: center; gap: ${M.ORD_GAP}px; min-height: ${M.HEAD_H}px; padding: 0 ${M.PAD}px; border-radius: 6px; white-space: nowrap; }
    .typeform .tord { width: ${M.ORD_W}px; flex: none; font-weight: 700; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .typeform .tmeta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .typeform .tname { font-size: 16px; font-weight: 600; color: var(--text-1); letter-spacing: -0.005em; }
    .typeform .tsub { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
    .typeform .thead .chip-more { margin-left: 10px; flex: none; }
    .typeform .tattn { height: ${M.ATTN_H}px; padding: 0 ${M.PAD}px 0 ${M.PAD + M.INDENT}px; font-size: 11px; font-weight: 400; line-height: ${M.ATTN_H}px; white-space: nowrap; }
    .typeform .tlines { display: flex; flex-direction: column; padding-top: ${M.HEAD_GAP}px; padding-left: ${M.INDENT}px; }
    .typeform .tline { display: grid; grid-template-columns: 12px ${M.NAME_W}px minmax(0, ${M.TASK_CAP}px) ${M.STATE_W}px 12px; column-gap: ${M.GAP}px; align-items: center; min-height: ${M.ROW_H}px; padding: 0 ${M.PAD}px; border-radius: 6px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; line-height: ${M.ROW_H}px; white-space: nowrap; }
    .typeform .tline.is-run { grid-template-rows: ${M.ROW_H}px ${M.RUN_H - M.ROW_H}px; min-height: ${M.RUN_H}px; }
    .typeform .tline.is-run > * { align-self: center; }
    .typeform .tsig { display: inline-flex; }
    .typeform .tnm { font-weight: 600; color: var(--text-1); }
    .typeform .ttask { color: rgba(255,255,255,0.78); overflow: hidden; text-overflow: ellipsis; }
    .typeform .tst { font-weight: 600; }
    .typeform .tac { display: inline-flex; color: var(--text-2); }
    .typeform .tactv { grid-column: 3 / 6; grid-row: 2; align-self: start; font-size: 10px; line-height: ${M.RUN_H - M.ROW_H}px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; }
    .typeform .tleader { position: absolute; display: flex; align-items: center; gap: 12px; }
    .typeform .tlav { width: 44px; height: 44px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; background: rgba(153,133,245,0.16); border: 1px solid rgba(153,133,245,0.45); color: var(--violet); }
    .typeform .tlmeta { display: flex; flex-direction: column; gap: 5px; }
    .typeform .tlname { font-size: 30px; font-weight: 700; line-height: 1; letter-spacing: -0.01em; color: var(--violet); border-bottom: 2px solid var(--mint); padding-bottom: 5px; align-self: flex-start; }
    .typeform .tlsub { font-size: 11px; font-weight: 500; color: var(--text-2); }
    .typeform .truler-tick { position: absolute; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; font-weight: 500; color: var(--text-2); transform: translateX(-50%); }
`;

if (!shell.includes("<!-- CANVAS_LAYER -->") || !shell.includes("<!-- CHRONO_CONTROL -->")) {
  throw new Error("shell.partial.html is missing a placeholder");
}

const html = shell
  .replace("    <!-- CANVAS_LAYER -->", canvas)
  .replace("<!-- CHRONO_CONTROL -->", chrono)
  .replace(
    "\n    @media (prefers-reduced-motion: reduce)",
    `${CSS}\n    @media (prefers-reduced-motion: reduce)`,
  );

writeFileSync(here("Type.dc.html"), html);

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

const rowCount = blocks.reduce((n, b) => n + b.rows.length, 0);
const chips = blocks.filter((b) => b.chip).length;
const report = fitReport(blocks);
console.log(
  `Type.dc.html — ${blocks.length} mission headers + ${rowCount} agent lines + ${chips} chips + 1 leader = ${blocks.length + rowCount + chips + 1} nodes`,
);
console.log(`fully inside x 280-1174: ${report.inBand.join(", ")} (* = runs past the bottom edge)`);
console.log(report.notes.length === 0 ? "no overlaps, every header inside the root" : report.notes.join("\n"));
