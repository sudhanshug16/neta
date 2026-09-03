// BANDS direction — chronology as vertical time bands read right to left.
// Design working file. Writes Bands.dc.html from shell.partial.html + dataset.json.

import { readFileSync, writeFileSync } from "node:fs";
import { esc, icon, sigil, stateClass, stateColor } from "./lib.mjs";

const data = JSON.parse(readFileSync(new URL("./dataset.json", import.meta.url), "utf8"));
const shell = readFileSync(new URL("./shell.partial.html", import.meta.url), "utf8");

/* ---------------------------------------------------------------- geometry */

// Bands run right (now) to left (past). The workspace leader anchors the right
// edge of the visible band; the Last hour band ends at it.
const BANDS = [
  { label: "Earlier", ords: ["04", "03", "02", "01"], x0: -110, x1: 110, scale: 0.88, alpha: 0.28 },
  { label: "This week", ords: ["07", "06", "05"], x0: 110, x1: 330, scale: 0.88, alpha: 0.34 },
  { label: "Yesterday", ords: ["09", "08"], x0: 330, x1: 586, scale: 1, alpha: 0.4 },
  { label: "Today", ords: ["13", "12", "11", "10"], x0: 586, x1: 900, scale: 1, alpha: 0.46 },
  { label: "Last hour", ords: ["14"], x0: 900, x1: 1164, scale: 1, alpha: 0.5 },
];

const TOP = 126; // first mission group under the band headers
const ROW_H = 26;
const RUN_H = 42;
const CHIP_H = 22;
const ROW_GAP = 6;
const LEAD_GAP = 8;
const MISSION_GAP = 20;
const INDENT = 14; // rows sit right of the trunk
const LEADER = { x: 912, y: 444, w: 240, h: 72 };

const byOrd = new Map(data.missions.map((m) => [m.ordinal, m]));

// Crude text metrics — enough to stack absolutely positioned cards.
const lineCount = (text, width, perChar) =>
  Math.max(1, Math.ceil((String(text).length * perChar) / Math.max(width, 1)));

/* ------------------------------------------------------------------- parts */

const accessIcon = (access) => `<span class="access">${icon(access === "read-write" ? "pencil" : "eye", 12)}</span>`;

const provMark = (provider) => `<span class="prov">${provider === "Codex" ? "X" : "C"}</span>`;

const ATTN_COLOR = { Blocked: "#F5AD47", Failed: "#FF6161", "Merged · not closed": "#8AB3FF" };
const ATTN_BORDER = {
  Blocked: "rgba(245,173,71,0.60)",
  Failed: "rgba(255,97,97,0.60)",
  "Merged · not closed": "rgba(138,179,255,0.60)",
};

function rowNode(agent, x, y, maxW) {
  const running = agent.state === "Running";
  const cls = [
    "node-row",
    running ? "is-running" : "",
    agent.state === "Blocked" ? "is-blocked" : "",
    agent.state === "Failed" ? "is-failed" : "",
    agent.state === "Completed" ? "is-completed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const activity = running && agent.activity ? `<span class="activity">${esc(agent.activity)}</span>` : "";
  return (
    `<div class="${cls}" style="left: ${x}px; top: ${y}px; max-width: ${maxW}px;">` +
    sigil(agent.name, agent.hue, 12) +
    `<span class="name">${esc(agent.name)}</span>` +
    `<span class="task">${esc(agent.task)}</span>` +
    `<span class="state" style="color: ${stateColor(agent.state)};"><i></i>${esc(agent.state)}</span>` +
    accessIcon(agent.access) +
    activity +
    `</div>`
  );
}

// Running, then blocked, then failed, then the 8 most recent completed.
function orderAgents(mission) {
  const pick = (s) => mission.agents.filter((a) => a.state === s);
  const front = [...pick("Running"), ...pick("Blocked"), ...pick("Failed")];
  const done = pick("Completed").slice().sort((a, b) => a.startedMinutesAgo - b.startedMinutesAgo);
  return { front, shown: done.slice(0, 8), hidden: Math.max(0, done.length - 8) };
}

function leadHeight(mission, colW) {
  const inner = colW - 24;
  let h = 20; // vertical padding
  if (mission.leadIsWorkspaceLeader) {
    h += 15 + 4 + lineCount(mission.name, inner, 6.9) * 17;
  } else {
    h += lineCount(mission.name, inner - 58, 6.9) * 17;
  }
  h += 4 + 15; // meta row
  if (mission.attention) h += 4 + lineCount(mission.attention, inner, 5.25) * 14;
  return h;
}

function leadCard(mission, colW) {
  const attnColor = ATTN_COLOR[mission.state];
  const border = ATTN_BORDER[mission.state] ? ` border-color: ${ATTN_BORDER[mission.state]};` : "";
  const stateRow =
    `<span class="node-state ${stateClass(mission.state)}" style="flex: none;">` +
    `<span class="state-dot"></span><span class="state-label">${esc(mission.state)}</span></span>`;
  const attn = mission.attention
    ? `<div class="node-attn" style="color: ${attnColor ?? "rgba(255,255,255,0.72)"};">${esc(mission.attention)}</div>`
    : "";

  let head;
  let meta;
  if (mission.leadIsWorkspaceLeader) {
    head =
      `<div class="node-row">` +
      `<span class="mono tnum lead-ord">${esc(mission.ordinal)}</span>` +
      `<span class="lead-by">· led by ${esc(data.leader.name)}</span>` +
      `<span class="mono tnum lead-age">${esc(mission.age)}</span>` +
      `</div>` +
      `<div class="lead-name">${esc(mission.name)}</div>`;
    meta =
      `<div class="lead-meta">` +
      stateRow +
      `<span style="flex: 1;"></span>` +
      `<span class="lead-crown">${icon("crown", 12)}</span>` +
      `<span class="lead-who" style="color: var(--violet);">${esc(data.leader.name)}</span>` +
      provMark(data.leader.provider) +
      accessIcon("read-write") +
      `</div>`;
  } else {
    head =
      `<div class="node-row" style="align-items: flex-start;">` +
      `<span class="mono tnum lead-ord">${esc(mission.ordinal)}</span>` +
      `<span class="lead-name" style="flex: 1; min-width: 0;">${esc(mission.name)}</span>` +
      `<span class="mono tnum lead-age">${esc(mission.age)}</span>` +
      `</div>`;
    meta =
      `<div class="lead-meta">` +
      stateRow +
      `<span style="flex: 1;"></span>` +
      sigil(mission.lead.name, mission.lead.hue, 12) +
      `<span class="lead-who">${esc(mission.lead.name)}</span>` +
      provMark(mission.lead.provider) +
      accessIcon(mission.lead.access) +
      `</div>`;
  }

  return (
    `<div class="node node-lead" style="left: 0px; top: 0px; width: ${colW}px; max-width: ${colW}px;${border}">` +
    head +
    meta +
    attn +
    `</div>`
  );
}

/* ------------------------------------------------------------------ layout */

const nodes = [];
const edgePaths = [];
const trunkGroups = [];
const chrome = [];
let rowCount = 0;
let chipCount = 0;
const missionBoxes = [];

for (const band of BANDS) {
  const bandW = band.x1 - band.x0;
  const colLeft = band.x0 + 12;
  const colW = Math.round((bandW - 24) / band.scale); // unscaled column width
  const rowMax = colW - INDENT;

  // divider + header
  if (band.x0 > 0) {
    chrome.push(`<div class="band-div" style="left: ${band.x0}px;"></div>`);
  }
  const kinds = band.ords
    .map((o) => byOrd.get(o).state)
    .filter((s) => ATTN_COLOR[s])
    .map((s) => ATTN_COLOR[s]);
  kinds.forEach((color, i) => {
    chrome.push(`<div class="band-tick" style="left: ${band.x0 + 3 + i * 5}px; background: ${color};"></div>`);
  });
  chrome.push(
    `<div class="band-head" style="left: ${colLeft}px;">` +
      `<span class="bh-name">${esc(band.label)}</span>` +
      `<span class="bh-count tnum">· ${band.ords.length}</span>` +
      `</div>`,
  );

  let cursor = TOP;
  for (const ord of band.ords) {
    const mission = byOrd.get(ord);
    const { front, shown, hidden } = orderAgents(mission);
    const leadH = leadHeight(mission, colW);

    const parts = [leadCard(mission, colW)];
    const centers = [];
    let y = leadH + LEAD_GAP;
    for (const agent of [...front, ...shown]) {
      const h = agent.state === "Running" ? RUN_H : ROW_H;
      parts.push(rowNode(agent, INDENT, y, rowMax));
      centers.push(y + h / 2);
      rowCount += 1;
      y += h + ROW_GAP;
    }
    if (hidden > 0) {
      parts.push(
        `<span class="chip-more" style="left: ${INDENT}px; top: ${y}px;">+${hidden} completed${icon("chevron-right", 11)}</span>`,
      );
      centers.push(y + CHIP_H / 2);
      chipCount += 1;
      y += CHIP_H + ROW_GAP;
    }
    const groupH = y - ROW_GAP;

    nodes.push(
      `<div class="mgroup" style="left: ${colLeft}px; top: ${cursor}px; width: ${colW}px; height: ${groupH}px;` +
        (band.scale === 1 ? "" : ` transform: scale(${band.scale});`) +
        `">${parts.join("")}</div>`,
    );

    // trunk + 6px stubs, drawn in the shared edge svg under the same transform
    if (centers.length > 0) {
      let d = `M 8 ${leadH} V ${centers[centers.length - 1]}`;
      for (const c of centers) d += ` M 8 ${c} H ${INDENT}`;
      trunkGroups.push(
        `<g transform="translate(${colLeft} ${cursor})${band.scale === 1 ? "" : ` scale(${band.scale})`}">` +
          `<path class="trunk" d="${d}"></path></g>`,
      );
    }

    missionBoxes.push({
      ord,
      x: colLeft,
      y: cursor,
      w: colW * band.scale,
      h: groupH * band.scale,
      anchorX: colLeft + colW * band.scale,
      anchorY: cursor + 26 * band.scale,
      state: mission.state,
      leaderLed: Boolean(mission.leadIsWorkspaceLeader),
      alpha: band.alpha,
    });

    cursor += groupH * band.scale + MISSION_GAP;
  }
}

/* ------------------------------------------------------------------- edges */

for (const box of missionBoxes) {
  if (box.ord === "14") {
    // Mission 14 sits directly above the leader in the Last hour band.
    const cx = Math.round(box.x + box.w / 2);
    const cy = Math.round(box.y + box.h);
    edgePaths.push(
      `<path class="edge edge-leader" style="stroke: rgba(153,133,245,${box.alpha});" d="M ${cx} ${LEADER.y} C ${cx} ${LEADER.y - 56} ${cx} ${cy + 56} ${cx} ${cy}"></path>`,
    );
    continue;
  }
  const x2 = Math.round(box.anchorX);
  const y2 = Math.round(box.anchorY);
  let d;
  if (LEADER.x - x2 < 140) {
    // Adjacent band: leave the leader vertically so the edge never doubles the divider.
    const sx = LEADER.x + 70;
    const above = y2 < LEADER.y + LEADER.h / 2;
    const sy = above ? LEADER.y : LEADER.y + LEADER.h;
    d = `M ${sx} ${sy} C ${sx} ${above ? sy - 76 : sy + 76} ${x2 + 58} ${above ? y2 + 76 : y2 - 76} ${x2} ${y2}`;
  } else {
    const x1 = LEADER.x;
    const y1 = LEADER.y + LEADER.h / 2;
    const dx = Math.min(240, Math.max(40, (x1 - x2) * 0.42));
    d = `M ${x1} ${y1} C ${Math.round(x1 - dx)} ${y1} ${Math.round(x2 + dx)} ${y2} ${x2} ${y2}`;
  }
  let cls = "edge edge-leader";
  let style = `stroke: rgba(153,133,245,${box.alpha});`;
  if (box.leaderLed) style = "stroke: rgba(153,133,245,0.85); stroke-width: 1.8;";
  else if (box.state === "Blocked") {
    cls += " edge-blocked";
    style = "stroke: rgba(245,173,71,0.6);";
  }
  edgePaths.push(`<path class="${cls}" style="${style}" d="${d}"></path>`);
}

/* ------------------------------------------------------------------ leader */

const leaderNode =
  `<div class="node node-leader" style="left: ${LEADER.x}px; top: ${LEADER.y}px; width: ${LEADER.w}px;">` +
  `<div class="node-row" style="gap: 12px;">` +
  `<span class="leader-avatar">${icon("crown", 20)}</span>` +
  `<div style="display: flex; flex-direction: column; gap: 2px; min-width: 0;">` +
  `<span class="leader-name">${esc(data.leader.name)}</span>` +
  `<span class="leader-sub">Workspace leader</span>` +
  `</div>` +
  `<span class="chip-mode" style="margin-left: auto;">${esc(data.leader.mode)}</span>` +
  `</div>` +
  `</div>`;

/* -------------------------------------------------------------- assemble */

const svg =
  `<svg class="edges" style="position: absolute; inset: 0; width: 1600px; height: 1000px;" aria-hidden="true">` +
  edgePaths.join("") +
  trunkGroups.join("") +
  `</svg>`;

const canvas =
  `<div class="rowform" style="position: absolute; inset: 0;">` +
  svg +
  chrome.join("") +
  nodes.join("") +
  leaderNode +
  `</div>`;

const chrono =
  icon("clock", 13) +
  `Bands` +
  `<span class="seg" style="margin-left: 3px;">` +
  `<span class="seg-item">Hour</span>` +
  `<span class="seg-item on">Day</span>` +
  `<span class="seg-item">Week</span>` +
  `</span>`;

const css = `    /* --- BANDS direction: time bands and row nodes (scoped to .rowform) --- */
    .rowform .band-div { position: absolute; top: 96px; bottom: 0; width: 1px; background: rgba(255,255,255,0.06); }
    .rowform .band-tick { position: absolute; top: 96px; width: 3px; height: 16px; border-radius: 1px; }
    .rowform .band-head { position: absolute; top: 96px; height: 16px; display: flex; align-items: center; gap: 5px; }
    .rowform .bh-name { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.80); }
    .rowform .bh-count { font-size: 10px; font-weight: 500; color: var(--text-2); }
    .rowform .mgroup { position: absolute; transform-origin: 0 0; }
    .rowform .trunk { fill: none; stroke: rgba(255,255,255,0.17); stroke-width: 1; stroke-linecap: round; vector-effect: non-scaling-stroke; }
    .rowform .mgroup > .node-row { position: absolute; display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 10px 0 8px; border-radius: 8px; background: rgba(20,23,25,0.96); border: 1px solid rgba(255,255,255,0.10); white-space: nowrap; max-width: 320px; box-sizing: border-box; }
    .rowform .mgroup > .node-row.is-running { height: auto; padding: 5px 10px 5px 8px; display: grid; grid-template-columns: auto auto minmax(0,1fr) auto auto; grid-template-rows: auto auto; column-gap: 8px; row-gap: 2px; align-items: center; }
    .rowform .mgroup > .node-row .name { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.94); flex: none; }
    .rowform .mgroup > .node-row .task { font-size: 11px; font-weight: 400; color: rgba(255,255,255,0.72); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .rowform .mgroup > .node-row .state { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 600; flex: none; }
    .rowform .mgroup > .node-row .state i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: currentColor; }
    .rowform .mgroup > .node-row .activity { grid-column: 2 / -1; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; color: rgba(255,255,255,0.56); overflow: hidden; text-overflow: ellipsis; }
    .rowform .mgroup > .node-row .access { width: 12px; height: 12px; color: rgba(255,255,255,0.56); display: inline-flex; }
    .rowform .mgroup > .node-row.is-blocked { border-color: rgba(245,173,71,0.5); }
    .rowform .mgroup > .node-row.is-failed { border-color: rgba(255,97,97,0.5); }
    .rowform .mgroup > .node-row.is-completed .name, .rowform .mgroup > .node-row.is-completed .task { opacity: 0.7; }
    .rowform .mgroup > .node-lead { position: absolute; box-shadow: 0 8px 22px rgba(0,0,0,0.34); }
    .rowform .mgroup > .chip-more { position: absolute; }
    .rowform .lead-meta { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .rowform .lead-who { font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.88); }
    .rowform .lead-by { font-size: 10px; font-weight: 600; color: var(--violet); flex: 1; }
    .rowform .lead-crown { display: flex; color: var(--violet); flex: none; }
    .rowform .node-attn { white-space: normal; }
`;

const html = shell
  .replace("    @media (prefers-reduced-motion: reduce)", `${css}\n    @media (prefers-reduced-motion: reduce)`)
  .replace("<!-- CANVAS_LAYER -->", canvas)
  .replace("<!-- CHRONO_CONTROL -->", chrono);

writeFileSync(new URL("./Bands.dc.html", import.meta.url), html);

const inBand = missionBoxes.filter((b) => b.x >= 280 && b.x + b.w <= 1174 && b.y + b.h <= 1000).map((b) => b.ord);
console.log(`rows ${rowCount}  leads ${missionBoxes.length}  chips ${chipCount}  leader 1  total ${rowCount + missionBoxes.length + chipCount + 1}`);
console.log(`fully inside x 280-1174 and above y=1000: ${inBand.join(", ")}`);
for (const b of missionBoxes) {
  console.log(`  ${b.ord}  x ${Math.round(b.x)}-${Math.round(b.x + b.w)}  y ${Math.round(b.y)}-${Math.round(b.y + b.h)}`);
}
