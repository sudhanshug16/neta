// Emits shell.partial.html: the artboard skeleton every canvas direction
// starts from. Run: node gen-shell.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { esc, icon, stateClass, stateShort } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, "dataset.json"), "utf8"));
const { workspace, leader, missions, leaderTranscript } = data;

/* ------------------------------------------------------------------ style */

const STYLE = `    * { box-sizing: border-box; }
    body { margin: 0; background: #0E0F13; }
    a { color: #8AB3FF; } a:hover { color: #B9CFFF; }

    /* --- type helpers --- */
    .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
    .tnum { font-variant-numeric: tabular-nums; }
    .sec { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-2); padding: 0 8px; }
    .ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

    /* --- state colours: the dot inherits currentColor --- */
    .state-running { color: var(--mint); }
    .state-blocked { color: var(--amber); }
    .state-failed { color: var(--red); }
    .state-completed { color: var(--green); }
    .state-ready { color: var(--blue); }
    .state-merged { color: var(--blue); }
    .state-idle { color: var(--text-2); }

    /* --- window ground --- */
    .ground { position: absolute; inset: 0; background-image: radial-gradient(var(--dot) 1.3px, transparent 1.4px); background-size: 28px 28px; }
    .traffic { position: absolute; left: 20px; top: 18px; display: flex; gap: 8px; z-index: 9; }
    .light { width: 12px; height: 12px; border-radius: 50%; background: #5C5F66; border: 1px solid rgba(0,0,0,0.40); }

    /* --- canvas layer (direction authors own everything inside) --- */
    .canvas-layer { z-index: 1; }
    .edge { fill: none; stroke: rgba(153,133,245,0.35); stroke-width: 1.4; stroke-linecap: round; }
    .edge-leader { stroke: rgba(153,133,245,0.5); }
    .edge-blocked { stroke-dasharray: 5 6; }

    /* --- node anatomy --- */
    .node { position: absolute; display: flex; flex-direction: column; gap: 4px; min-width: 168px; max-width: 236px; padding: 10px 12px; border-radius: 14px; background: var(--node-fill); border: 1px solid var(--node-border); box-shadow: 0 6px 18px rgba(0,0,0,0.30); }
    .node.selected { border: 2px solid var(--mint); padding: 9px 11px; }
    .node-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .node-name { font-size: 13px; font-weight: 600; line-height: 1.24; letter-spacing: -0.01em; }
    .node-task { font-size: 11px; font-weight: 400; line-height: 1.36; color: rgba(255,255,255,0.90); text-wrap: pretty; }
    .node-state { display: flex; align-items: center; gap: 5px; min-width: 0; }
    .state-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
    .state-label { font-size: 10px; font-weight: 600; letter-spacing: 0.005em; flex: none; }
    .node-activity { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; font-weight: 400; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .node-attn { font-size: 10px; font-weight: 500; line-height: 1.35; color: rgba(255,255,255,0.72); text-wrap: pretty; }
    .prov { width: 14px; height: 14px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 700; color: var(--text-2); background: var(--surface); flex: none; }
    .access { display: flex; color: var(--text-2); flex: none; }
    .sigil { display: block; flex: none; }

    /* --- workspace leader node --- */
    .node-leader { gap: 10px; min-width: 236px; max-width: 272px; padding: 14px 16px; border-radius: 18px; border: 1px solid rgba(153,133,245,0.60); background: rgba(21,21,31,0.97); box-shadow: 0 16px 40px rgba(0,0,0,0.45); }
    .leader-avatar { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: none; color: var(--violet); background: rgba(153,133,245,0.18); border: 1px solid rgba(153,133,245,0.55); }
    .leader-name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
    .leader-sub { font-size: 10px; font-weight: 500; color: var(--text-2); }
    .chip-mode { display: inline-flex; align-items: center; height: 16px; padding: 0 6px; border-radius: 5px; background: rgba(153,133,245,0.18); color: var(--violet); font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; flex: none; }

    /* --- mission lead node --- */
    .node-lead { min-width: 196px; max-width: 236px; }
    .lead-ord { font-size: 11px; font-weight: 600; color: var(--text-2); flex: none; }
    .lead-age { font-size: 11px; font-weight: 600; color: var(--text-2); flex: none; margin-left: auto; }
    .lead-name { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }

    /* --- +N completed expander --- */
    .chip-more { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px 0 9px; border-radius: 11px; background: var(--surface); border: 1px solid var(--node-border); color: var(--text-2); font-size: 10px; font-weight: 600; white-space: nowrap; }

    /* --- floating panels --- */
    .panel { position: absolute; background: var(--panel-fill); border: 1px solid var(--panel-border); border-radius: var(--panel-radius); box-shadow: var(--panel-shadow); backdrop-filter: blur(24px); overflow: hidden; }

    /* --- navigator --- */
    .nav { left: 16px; top: 48px; width: 248px; height: 936px; padding: 16px; z-index: 6; display: flex; flex-direction: column; gap: 14px; }
    .nav-head { padding: 0 8px 2px; display: flex; flex-direction: column; gap: 1px; }
    .nav-word { font-size: 15px; font-weight: 700; letter-spacing: -0.015em; }
    .nav-sub { font-size: 10px; font-weight: 500; color: var(--text-2); }
    .nav-group { display: flex; flex-direction: column; gap: 2px; }
    .nav-row { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 8px; border-radius: 7px; font-size: 12px; font-weight: 500; min-width: 0; }
    .nav-row.sel { background: var(--surface-sel); }
    .nav-trail { font-size: 10px; font-weight: 600; color: var(--text-2); flex: none; }
    .mono-sq { width: 18px; height: 18px; border-radius: 5px; background: var(--surface); display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 700; color: var(--text-2); flex: none; }
    .mono-sq.on { background: rgba(255,255,255,0.10); color: rgba(255,255,255,0.88); }
    .live { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; margin: 0 6px; }
    .nav-lead-av { width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: none; color: var(--violet); background: rgba(153,133,245,0.18); border: 1px solid rgba(153,133,245,0.45); }
    .nav-lead-mode { font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--violet); flex: none; }
    .grp-head { display: flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px; }
    .mi-row { height: 24px; gap: 6px; padding: 0 7px; }
    .mi-ord { font-size: 11px; font-weight: 600; color: var(--text-2); flex: none; }
    .mi-state { font-size: 10px; font-weight: 600; flex: none; }

    /* --- chat --- */
    .chat { right: 16px; top: 48px; width: 410px; height: 936px; z-index: 6; display: flex; flex-direction: column; }
    .chat-head { padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 11px; border-bottom: 1px solid var(--divider); flex: none; }
    .chat-av { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: none; color: var(--violet); background: rgba(153,133,245,0.18); border: 1px solid rgba(153,133,245,0.55); }
    .chat-name { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
    .chat-tag { display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 4px; background: var(--surface); color: var(--text-2); font-size: 9px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; flex: none; }
    .chat-sub { font-size: 10px; font-weight: 500; color: var(--text-2); }
    .seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--surface); flex: none; }
    .seg-item { height: 20px; padding: 0 10px; border-radius: 6px; display: flex; align-items: center; font-size: 10px; font-weight: 600; color: var(--text-2); }
    .seg-item.on { background: rgba(153,133,245,0.20); color: var(--violet); }
    .btn-text { font-size: 11px; font-weight: 600; color: var(--text-2); padding: 0 2px; flex: none; }
    .btn-stop { width: 24px; height: 24px; border-radius: 50%; background: var(--surface); border: 1px solid var(--panel-border); display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.72); flex: none; }
    .strip { display: flex; align-items: center; gap: 6px; padding: 7px 14px; background: rgba(153,133,245,0.12); color: var(--violet); font-size: 10px; font-weight: 500; flex: none; }
    .msgs { flex: 1; padding: 16px 14px; display: flex; flex-direction: column; justify-content: flex-end; gap: 12px; overflow: hidden; }
    .msg-wrap { display: flex; flex-direction: column; gap: 3px; max-width: 306px; }
    .msg-wrap.me { align-self: flex-end; align-items: flex-end; }
    .msg-wrap.them { align-self: flex-start; align-items: flex-start; }
    .msg { padding: 8px 11px; border-radius: 13px; font-size: 12.5px; font-weight: 400; line-height: 1.42; text-wrap: pretty; }
    .msg-user { background: rgba(153,133,245,0.55); color: rgba(255,255,255,0.98); border-bottom-right-radius: 5px; }
    .msg-agent { background: var(--surface); border-bottom-left-radius: 5px; }
    .msg-time { font-size: 9px; font-weight: 500; color: var(--text-2); padding: 0 3px; }
    .msg-sys { align-self: center; text-align: center; max-width: 320px; font-size: 10px; font-weight: 500; line-height: 1.4; color: var(--text-2); }
    .composer { padding: 12px 14px 14px; border-top: 1px solid var(--divider); display: flex; align-items: center; gap: 8px; flex: none; }
    .composer-input { flex: 1; height: 34px; border-radius: 10px; background: var(--surface); border: 1px solid var(--panel-border); display: flex; align-items: center; padding: 0 11px; font-size: 12.5px; color: var(--text-2); }
    .send { width: 30px; height: 30px; border-radius: 50%; background: var(--mint); color: #0E0F13; display: flex; align-items: center; justify-content: center; flex: none; }

    /* --- toolbar --- */
    .toolbar { position: absolute; left: 800px; transform: translateX(-50%); top: 18px; height: 40px; z-index: 7; display: flex; align-items: center; padding: 0 7px; border-radius: 20px; background: rgba(24,26,32,0.72); border: 1px solid var(--panel-border); box-shadow: var(--panel-shadow); backdrop-filter: blur(18px); }
    .tb-item { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; border-radius: 8px; font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.88); white-space: nowrap; }
    .tb-chev { color: var(--text-2); display: flex; }
    .tb-div { width: 1px; height: 18px; background: var(--divider); margin: 0 4px; flex: none; }
    .tb-icon { width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: var(--text-2); flex: none; }
    .tb-zoom { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; font-weight: 600; color: rgba(255,255,255,0.88); min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; }

    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }`;

/* ------------------------------------------------------------- navigator */

const WORKSPACES = [
  { name: "NoScrubs", mono: "NS", selected: true },
  { name: "neta", mono: "NE", selected: false },
  { name: "fx-ledger", mono: "FX", selected: false },
];

const workspaceRows = WORKSPACES.map((w) => `          <div class="nav-row${w.selected ? " sel" : ""}"><span class="mono-sq${w.selected ? " on" : ""}">${esc(w.mono)}</span><span class="ell" style="flex: 1;">${esc(w.name)}</span></div>`).join("\n");

const machineRows = workspace.machines
  .map((m) => `          <div class="nav-row"><span class="${m.online ? "state-running" : "state-idle"}" style="display: flex;"><span class="live"></span></span><span class="ell" style="flex: 1;">${esc(m.name)}</span><span class="nav-trail">${m.online ? "Online" : "Offline"}</span></div>`)
  .join("\n");

const NEEDS_YOU = ["Blocked", "Failed", "Merged · not closed"];
const groups = [
  { title: "Needs you", items: missions.filter((m) => NEEDS_YOU.includes(m.state)) },
  { title: "Ready to close", items: missions.filter((m) => m.state === "Ready to close") },
  { title: "Running", items: missions.filter((m) => m.state === "Running") },
];

const inboxGroups = groups
  .map((g) => {
    const rows = g.items
      .map(
        (m) =>
          `            <div class="nav-row mi-row"><span class="mono tnum mi-ord">${esc(m.ordinal)}</span><span class="ell" style="flex: 1;">${esc(m.name)}</span><span class="mi-state ${stateClass(m.state)}">${esc(stateShort(m.state))}</span></div>`,
      )
      .join("\n");
    return `          <div class="nav-group">
            <div class="grp-head"><span class="sec" style="padding: 0; flex: 1;">${esc(g.title)}</span><span class="nav-trail tnum">${g.items.length}</span></div>
${rows}
          </div>`;
  })
  .join("\n");

const navigator = `      <aside class="panel nav">
        <div class="nav-head">
          <div class="nav-word">Neta</div>
          <div class="nav-sub">Workspaces</div>
        </div>
        <div class="nav-group">
${workspaceRows}
        </div>
        <div class="nav-group">
          <div class="sec" style="height: 20px; display: flex; align-items: center;">Machine</div>
${machineRows}
        </div>
        <div class="nav-group">
          <div class="sec" style="height: 20px; display: flex; align-items: center;">Workspace leader</div>
          <div class="nav-row sel"><span class="nav-lead-av">${icon("crown", 11)}</span><span class="ell" style="flex: 1;">${esc(leader.name)}</span><span class="nav-lead-mode">${esc(leader.mode)}</span></div>
        </div>
        <div class="nav-group" style="gap: 8px;">
          <div class="sec" style="height: 20px; display: flex; align-items: center;">Mission inbox</div>
${inboxGroups}
        </div>
        <div class="nav-group">
          <div class="nav-row"><span class="ell" style="flex: 1;">Archive</span><span class="nav-trail tnum">${workspace.archivedCount}</span></div>
        </div>
      </aside>`;

/* ------------------------------------------------------------------ chat */

const messages = leaderTranscript
  .map((m) => {
    if (m.author === "system") {
      return `          <div class="msg-sys">${esc(m.text)}</div>`;
    }
    const me = m.author === "user";
    return `          <div class="msg-wrap ${me ? "me" : "them"}">
            <div class="msg ${me ? "msg-user" : "msg-agent"}">${esc(m.text)}</div>
            <div class="msg-time tnum">${esc(me ? "You" : leader.name)} · ${esc(m.time)}</div>
          </div>`;
  })
  .join("\n");

const activeMission = missions.find((m) => m.ordinal === leader.activeMissionOrdinal);

const chat = `      <section class="panel chat">
        <div class="chat-head">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span class="chat-av">${icon("crown", 16)}</span>
            <div style="display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1;">
              <div style="display: flex; align-items: center; gap: 7px; min-width: 0;">
                <span class="chat-name">${esc(leader.name)}</span>
                <span class="chat-tag">Workspace leader</span>
              </div>
              <div class="chat-sub ell">${esc(leader.provider)} · ${esc(leader.model)} · Running</div>
            </div>
            <span class="btn-text">Details</span>
            <span class="btn-stop">${icon("stop", 12)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="seg" title="Lead++ gives this leader build access">
              <span class="seg-item">Lead</span>
              <span class="seg-item on">Lead++</span>
            </span>
          </div>
        </div>
        <div class="strip">
          ${icon("clock", 12)}
          <span>Lead++ active <span class="tnum">${leader.modeActiveMinutes}</span> min · <span class="mono tnum">${esc(activeMission.ordinal)}</span> ${esc(activeMission.name)}</span>
        </div>
        <div class="msgs">
${messages}
        </div>
        <div class="composer">
          <div class="composer-input">Message the workspace leader</div>
          <span class="send">${icon("arrow-up", 15, "#0E0F13")}</span>
        </div>
      </section>`;

/* --------------------------------------------------------------- toolbar */

const onlineMachine = workspace.machines.find((m) => m.online);

const toolbar = `      <div class="toolbar">
        <span class="tb-item">${esc(workspace.name)}<span class="tb-chev">${icon("chevron-down", 12)}</span></span>
        <span class="tb-div"></span>
        <span class="tb-item"><span class="state-running" style="display: flex;"><span class="live" style="margin: 0;"></span></span>${esc(onlineMachine.name)}<span class="tb-chev">${icon("chevron-down", 12)}</span></span>
        <span class="tb-div"></span>
        <span class="tb-item">${icon("fit", 13)}Fit</span>
        <span class="tb-div"></span>
        <span class="tb-icon">${icon("minus", 13)}</span>
        <span class="tb-zoom">100%</span>
        <span class="tb-icon">${icon("plus", 13)}</span>
        <span class="tb-div"></span>
        <span class="tb-item tb-chrono"><!-- CHRONO_CONTROL --></span>
      </div>`;

/* -------------------------------------------------------------- assembly */

const ROOT_STYLE = [
  "position: relative",
  "width: 1600px",
  "height: 1000px",
  "overflow: hidden",
  "background: #0E0F13",
  "font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
  "color: rgba(255,255,255,0.94)",
  "-webkit-font-smoothing: antialiased",
  "--ground: #0E0F13",
  "--panel-fill: rgba(24,26,32,0.92)",
  "--panel-border: rgba(255,255,255,0.10)",
  "--panel-shadow: 0 12px 28px rgba(0,0,0,0.28)",
  "--panel-radius: 18px",
  "--node-fill: rgba(20,23,25,0.96)",
  "--node-border: rgba(255,255,255,0.10)",
  "--dot: rgba(255,255,255,0.115)",
  "--text-1: rgba(255,255,255,0.94)",
  "--text-2: rgba(255,255,255,0.56)",
  "--divider: rgba(255,255,255,0.06)",
  "--surface: rgba(255,255,255,0.045)",
  "--surface-hover: rgba(255,255,255,0.07)",
  "--surface-sel: rgba(255,255,255,0.075)",
  "--violet: #9985F5",
  "--mint: #73D1B8",
  "--blue: #8AB3FF",
  "--amber: #F5AD47",
  "--green: #7DD98C",
  "--red: #FF6161",
  "--hue-0: #52B3F2",
  "--hue-1: #F28775",
  "--hue-2: #C7A34F",
  "--hue-3: #70CC99",
  "--hue-4: #E39BC7",
  "--hue-5: #7FC8D9",
].join("; ");

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
${STYLE}
  </style>
</helmet>
<div class="dc-root" style="${ROOT_STYLE};">
  <div class="ground"></div>
  <div class="traffic">
    <span class="light"></span>
    <span class="light"></span>
    <span class="light"></span>
  </div>
  <div class="canvas-layer" style="position: absolute; inset: 0;">
    <!-- CANVAS_LAYER -->
  </div>
${toolbar}
${navigator}
${chat}
</div>
</x-dc>
</body>
</html>
`;

writeFileSync(join(here, "shell.partial.html"), html);
console.log(`wrote shell.partial.html (${html.split("\n").length - 1} lines)`);
