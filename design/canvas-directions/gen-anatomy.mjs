// Anatomy.dc.html — the component sheet for the shared node system.
// Documents every node, chip, edge and legend token that all canvas
// directions reuse. Design working file; nothing here ships as app code.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { esc, icon, sigil, stateClass, stateColor } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, "dataset.json"), "utf8"));
const shell = readFileSync(join(here, "shell.partial.html"), "utf8");

const W = 1240;
const H = 820;
const PAD = 40;
const INNER = W - PAD * 2; // 1160

/* ---------------------------------------------------------------- dataset */

const missionBy = new Map(data.missions.map((m) => [m.ordinal, m]));
const mission = (ord) => {
  const m = missionBy.get(ord);
  if (!m) throw new Error(`no mission ${ord}`);
  return m;
};
const agentIn = (ord, name) => {
  const m = mission(ord);
  const a = m.agents.find((x) => x.name === name);
  if (!a) throw new Error(`no agent ${name} in mission ${ord}`);
  return a;
};

/* ------------------------------------------------------------ style block */

// The shell's helmet <style>, copied verbatim so the sheet documents exactly
// what the directions render.
const helmetStyle = shell.slice(
  shell.indexOf("<style>"),
  shell.indexOf("</style>") + "</style>".length,
);
if (!helmetStyle.startsWith("<style>")) throw new Error("no <style> in shell helmet");

// The shell's root token declarations, verbatim, resized for this sheet.
const rootStyleMatch = shell.match(/<div class="dc-root" style="([^"]*)">/);
if (!rootStyleMatch) throw new Error("no dc-root in shell");
const rootStyle =
  rootStyleMatch[1]
    .replace("width: 1600px", `width: ${W}px`)
    .replace("height: 1000px", `height: ${H}px`) +
  ` padding: ${PAD}px; display: flex; flex-direction: column; gap: 32px;`;

// Sheet-local classes. The row-node block below is the spec verbatim, with two
// deliberate deviations, both flagged in the report:
//   1. every selector is scoped under .rowform, because the shell already
//      defines a different .node-row (the header row inside .node);
//   2. one appended rule pins .name/.state so a fit-content flex row shrinks
//      the task and nothing else.
const sheetStyle = `<style>
    /* --- sheet scaffolding --- */
    .grp { display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; gap: 32px; align-items: flex-start; }
    .cap { display: flex; align-items: baseline; height: 12px; gap: 10px; font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.56); line-height: 12px; }
    .cap .note { font-size: 10px; font-weight: 400; letter-spacing: 0; text-transform: none; color: rgba(255,255,255,0.40); }
    .sub { font-size: 10px; font-weight: 500; color: var(--text-2); }
    .spec { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 9px; font-weight: 400; color: rgba(255,255,255,0.40); }

    /* --- row-form node: the compact single-line agent for dense canvases --- */
    .rowform .node-row { position:relative; display:flex; align-items:center; gap:8px; height:26px; padding:0 10px 0 8px; border-radius:8px; background:rgba(20,23,25,0.96); border:1px solid rgba(255,255,255,0.10); white-space:nowrap; max-width:320px; box-sizing:border-box; width:fit-content; }
    .rowform .node-row.is-running { height:auto; padding:5px 10px 5px 8px; display:grid; grid-template-columns:auto auto minmax(0,1fr) auto auto; grid-template-rows:auto auto; column-gap:8px; row-gap:2px; align-items:center; }
    .rowform .node-row .name { font-size:12px; font-weight:600; color:rgba(255,255,255,0.94); }
    .rowform .node-row .task { font-size:11px; font-weight:400; color:rgba(255,255,255,0.72); overflow:hidden; text-overflow:ellipsis; min-width:0; }
    .rowform .node-row .state { display:flex; align-items:center; gap:5px; font-size:10px; font-weight:600; }
    .rowform .node-row .state i { width:6px; height:6px; border-radius:50%; display:inline-block; background:currentColor; }
    .rowform .node-row .activity { grid-column:2 / -1; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:10px; color:rgba(255,255,255,0.56); overflow:hidden; text-overflow:ellipsis; }
    .rowform .node-row .access { width:12px; height:12px; color:rgba(255,255,255,0.56); display:inline-flex; }
    .rowform .node-row.is-blocked { border-color:rgba(245,173,71,0.5); }
    .rowform .node-row.is-failed { border-color:rgba(255,97,97,0.5); }
    .rowform .node-row.is-completed .name, .rowform .node-row.is-completed .task { opacity:0.7; }
    /* only the task may shrink in a fit-content flex row */
    .rowform .node-row .name, .rowform .node-row .state { flex: none; }
  </style>`;

/* --------------------------------------------------------------- fragments */

const accessIcon = (access, size = 12) =>
  icon(access === "read-only" ? "eye" : "pencil", size);
const provMark = (provider) => `<span class="prov">${provider === "Codex" ? "X" : "C"}</span>`;

function group(caption, note, body, width) {
  const w = width ? ` style="width: ${width}px; flex: none;"` : "";
  const n = note ? `<span class="note">${esc(note)}</span>` : "";
  return `<section class="grp"${w}>
        <div class="cap"><span>${esc(caption)}</span>${n}</div>
        ${body}
      </section>`;
}

// 1 — workspace leader, with and without the Lead++ chip.
function leaderNode(showChip) {
  const chip = showChip
    ? `<span class="chip-mode" style="margin-left: auto;">Lead++</span>`
    : "";
  return `<div class="node node-leader" style="position: relative; width: 256px;">
            <div class="node-row" style="gap: 12px;">
              <span class="leader-avatar">${icon("crown", 20)}</span>
              <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0;">
                <span class="leader-name">${esc(data.leader.name)}</span>
                <span class="leader-sub">Workspace leader</span>
              </div>${chip}
            </div>
          </div>`;
}

const sec1 = group(
  "Workspace leader",
  "One per workspace",
  `<div style="display: flex; gap: 24px; align-items: flex-start;">
          ${leaderNode(false)}
          ${leaderNode(true)}
        </div>`,
  536,
);

// 2 — mission lead cards.
function leadNode(ord) {
  const m = mission(ord);
  const attn = m.attention
    ? `\n            <div class="node-attn" style="color: ${stateColor(m.state)};">${esc(m.attention)}</div>`
    : "";
  return `<div class="node node-lead" style="position: relative; width: 216px;">
            <div class="node-row">
              <span class="mono tnum lead-ord">${esc(m.ordinal)}</span>
              <span style="flex: 1;"></span>
              <span class="mono tnum lead-age">${esc(m.age)}</span>
            </div>
            <div class="lead-name">${esc(m.name)}</div>
            <div class="node-state ${stateClass(m.state)}">
              <span class="state-dot"></span>
              <span class="state-label">${esc(m.state)}</span>
            </div>${attn}
          </div>`;
}

const sec2 = group(
  "Mission lead",
  "Ordinal, age, name and state on every mission",
  `<div style="display: flex; gap: 20px; align-items: flex-start;">
          ${["07", "12", "09", "08", "01"].map(leadNode).join("\n          ")}
        </div>`,
);

// 3 — agent, card form.
function agentCard(ord, name) {
  const a = agentIn(ord, name);
  const activity = a.activity
    ? `\n            <div class="node-activity">${esc(a.activity)}</div>`
    : "";
  return `<div class="node node-agent" style="position: relative; width: 236px;">
            <div class="node-row">
              ${sigil(a.name, a.hue)}
              <span class="node-name ell" style="flex: 1;">${esc(a.name)}</span>
              ${provMark(a.provider)}
              <span class="access">${accessIcon(a.access)}</span>
            </div>
            <div class="node-task">${esc(a.task)}</div>
            <div class="node-state ${stateClass(a.state)}">
              <span class="state-dot"></span>
              <span class="state-label">${esc(a.state)}</span>
            </div>
            <div class="sub">${esc(a.model)}</div>${activity}
          </div>`;
}

const CARD_AGENTS = [
  ["07", "Iris"], // Running
  ["12", "Zed"], // Blocked
  ["09", "Vesper"], // Failed
  ["07", "Ren"], // Completed
];

const sec3 = group(
  "Agent, card form",
  "Full task name, never truncated",
  `<div style="display: flex; gap: 24px; align-items: flex-start;">
          ${CARD_AGENTS.map(([o, n]) => agentCard(o, n)).join("\n          ")}
        </div>`,
);

// 4 / 5 — agent, row form.
const IS_CLASS = {
  Running: "is-running",
  Blocked: "is-blocked",
  Failed: "is-failed",
  Completed: "is-completed",
};

function agentRow(a) {
  const activity =
    a.state === "Running" && a.activity
      ? `\n              <span class="activity">${esc(a.activity)}</span>`
      : "";
  return `<div class="node-row ${IS_CLASS[a.state]}">
              ${sigil(a.name, a.hue)}
              <span class="name">${esc(a.name)}</span>
              <span class="task">${esc(a.task)}</span>
              <span class="state" style="color: ${stateColor(a.state)};"><i></i>${esc(a.state)}</span>
              <span class="access">${accessIcon(a.access)}</span>${activity}
            </div>`;
}

const sec4 = group(
  "Agent, row form",
  "Dense canvases; Running keeps its activity line",
  `<div class="rowform" style="display: grid; grid-template-columns: repeat(2, 320px); gap: 8px 16px; align-items: start;">
          ${CARD_AGENTS.map(([o, n]) => agentRow(agentIn(o, n))).join("\n          ")}
        </div>`,
  656,
);

// 5 — the +N completed expander. Mission 01 runs 16 agents: 8 shown on the
// canvas, the remaining 8 behind one chip.
const HIDDEN_01 = ["Gwen", "Lena", "Piet", "Uri"];

const sec5 = group(
  "Completed expander",
  "Never a bubble node",
  `<div class="rowform" style="display: flex; gap: 32px; align-items: flex-start;">
          <span class="chip-more">+8 completed${icon("chevron-right")}</span>
          <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-start;">
            <span class="chip-more">8 completed${icon("chevron-down")}</span>
            <div style="display: flex; flex-direction: column; gap: 3px; align-items: flex-start; opacity: 0.7;">
              ${HIDDEN_01.map((n) => agentRow(agentIn("01", n))).join("\n              ")}
            </div>
          </div>
        </div>`,
  472,
);

// 6 — edges.
const anchor = (x, y) =>
  `<rect x="${x}" y="${y}" width="12" height="8" rx="2.5" fill="rgba(20,23,25,0.96)" stroke="rgba(255,255,255,0.10)"></rect>`;

function edgeSample(paths, label, spec) {
  return `<div style="display: flex; flex-direction: column; gap: 6px; width: 146px;">
            <svg width="146" height="30" viewBox="0 0 146 30" fill="none" aria-hidden="true">${paths}</svg>
            <div class="sub">${esc(label)}</div>
            <div class="spec">${esc(spec)}</div>
          </div>`;
}

const sec6 = group(
  "Edges",
  "Subordinate to labels and status",
  `<div style="display: flex; gap: 17px; align-items: flex-start;">
          ${edgeSample(
            `${anchor(0, 20)}${anchor(128, 4)}<path class="edge edge-leader" d="M 12 24 C 46 24 68 8 128 8"></path>`,
            "Leader → mission lead",
            "rgba(153,133,245,0.5)",
          )}
          ${edgeSample(
            `${anchor(0, 11)}${anchor(76, 0)}${anchor(76, 11)}${anchor(76, 22)}<path class="edge" d="M 12 15 H 70"></path><path class="edge" d="M 70 4 V 26"></path><path class="edge" d="M 70 4 h 6"></path><path class="edge" d="M 70 15 h 6"></path><path class="edge" d="M 70 26 h 6"></path>`,
            "Lead → agents, 6px stubs",
            "rgba(153,133,245,0.35)",
          )}
          ${edgeSample(
            `${anchor(0, 4)}${anchor(128, 20)}<path class="edge edge-blocked" style="stroke: rgba(245,173,71,0.5);" d="M 12 8 C 46 8 68 24 128 24"></path>`,
            "Blocked target",
            "amber · dasharray 5 6",
          )}
        </div>`,
  472,
);

// 7 — identity. Same name, same hue, same mark, in every direction.
const IDENTITY = [
  ["Xen", "01"], // hue 0
  ["Nell", "12"], // hue 0 — same hue, different mark
  ["Lark", "01"], // hue 1
  ["Iris", "07"], // hue 2
  ["Delphi", "07"], // hue 3
  ["Marlowe", "07"], // hue 4
  ["Zed", "12"], // hue 4 — same hue, different mark
  ["Wren", "01"], // hue 5
];

function identityItem(name, ord) {
  const m = mission(ord);
  const a =
    m.lead && m.lead.name === name ? m.lead : m.agents.find((x) => x.name === name);
  if (!a) throw new Error(`no identity ${name}`);
  return `<div style="display: flex; align-items: center; gap: 8px;">
            ${sigil(a.name, a.hue, 24)}
            ${sigil(a.name, a.hue, 12)}
            <span style="font-size: 12px; font-weight: 600;">${esc(a.name)}</span>
          </div>`;
}

const sec7 = group(
  "Identity",
  "Name, task, model, access. No roles.",
  `<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px 16px;">
          ${IDENTITY.map(([n, o]) => identityItem(n, o)).join("\n          ")}
        </div>`,
  592,
);

// 8 — state and access legend.
const LEGEND_STATES = [
  ["Running", "dot"],
  ["Blocked", "question"],
  ["Failed", "x"],
  ["Completed", "check"],
  ["Ready to close", "check"],
  ["Merged · not closed", "merge"],
];

function legendRow(state, iconName) {
  const color = stateColor(state);
  return `<div class="${stateClass(state)}" style="display: flex; align-items: center; gap: 8px; height: 20px;">
            <span class="state-dot"></span>
            <span style="display: flex; color: currentColor;">${icon(iconName)}</span>
            <span style="font-size: 11px; font-weight: 600;">${esc(state)}</span>
            <span class="mono" style="margin-left: auto; font-size: 10px; color: rgba(255,255,255,0.40);">${color}</span>
          </div>`;
}

function accessItem(inner, label) {
  return `<div style="display: flex; align-items: center; gap: 7px;">
              ${inner}
              <span style="font-size: 11px; font-weight: 500; color: rgba(255,255,255,0.72);">${esc(label)}</span>
            </div>`;
}

const sec8 = group(
  "State and access",
  "Colour is never the only signal",
  `<div style="display: flex; flex-direction: column; gap: 12px;">
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 32px;">
            ${LEGEND_STATES.map(([s, i]) => legendRow(s, i)).join("\n            ")}
          </div>
          <div style="height: 1px; background: var(--divider);"></div>
          <div style="display: flex; align-items: center; gap: 26px;">
            ${accessItem(`<span class="access">${icon("eye")}</span>`, "Read-only")}
            ${accessItem(`<span class="access">${icon("pencil")}</span>`, "Read-write")}
            ${accessItem(`<span class="prov">C</span>`, "Claude")}
            ${accessItem(`<span class="prov">X</span>`, "Codex")}
          </div>
        </div>`,
  656,
);

/* ------------------------------------------------------------------ output */

const body = [
  `<div class="row">\n      ${sec1}\n      ${sec7}\n    </div>`,
  sec2,
  sec3,
  `<div class="row">\n      ${sec4}\n      ${sec6}\n    </div>`,
  `<div class="row">\n      ${sec5}\n      ${sec8}\n    </div>`,
].join("\n    ");

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  ${helmetStyle}
  ${sheetStyle}
</helmet>
<div class="dc-root" style="${rootStyle}">
    ${body}
</div>
</x-dc>
</body>
</html>
`;

writeFileSync(join(here, "Anatomy.dc.html"), html);
console.log(`Anatomy.dc.html written — ${W}x${H}, inner ${INNER}px`);
