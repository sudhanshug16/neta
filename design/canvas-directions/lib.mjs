// Shared drawing helpers for the Neta canvas directions.
// Every direction generator imports this so identical agents look identical
// across artboards. Design working file — nothing here ships as app code.

export const TOKENS = {
  ground: "#0E0F13",
  panelFill: "rgba(24,26,32,0.92)",
  panelBorder: "rgba(255,255,255,0.10)",
  panelShadow: "0 12px 28px rgba(0,0,0,0.28)",
  panelRadius: "18px",
  nodeFill: "rgba(20,23,25,0.96)",
  nodeBorder: "rgba(255,255,255,0.10)",
  dot: "rgba(255,255,255,0.115)",
  text1: "rgba(255,255,255,0.94)",
  text2: "rgba(255,255,255,0.56)",
  divider: "rgba(255,255,255,0.06)",
  surface: "rgba(255,255,255,0.045)",
  surfaceHover: "rgba(255,255,255,0.07)",
  surfaceSelected: "rgba(255,255,255,0.075)",
  violet: "#9985F5",
  mint: "#73D1B8",
  blue: "#8AB3FF",
  amber: "#F5AD47",
  green: "#7DD98C",
  red: "#FF6161",
};

// Agent identity palette. Index 0-5; agents carry their index in dataset.json.
const HUES = ["#52B3F2", "#F28775", "#C7A34F", "#70CC99", "#E39BC7", "#7FC8D9"];

export function hueColor(i) {
  return HUES[((Number(i) % HUES.length) + HUES.length) % HUES.length];
}

// FNV-1a. Stable across runs and machines, unlike any hash from a library.
export function hashName(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// The hue index baked into dataset.json. Kept here so the dataset and the
// artboards can never disagree about what colour an agent is.
export function hueFor(name) {
  return hashName(name) % HUES.length;
}

const STATE_COLORS = {
  Running: TOKENS.mint,
  Blocked: TOKENS.amber,
  Failed: TOKENS.red,
  Completed: TOKENS.green,
  "Ready to close": TOKENS.blue,
  Ready: TOKENS.blue,
  "Merged · not closed": TOKENS.blue,
  Merged: TOKENS.blue,
  Archived: TOKENS.text2,
  Offline: TOKENS.text2,
};

const STATE_CLASSES = {
  Running: "state-running",
  Blocked: "state-blocked",
  Failed: "state-failed",
  Completed: "state-completed",
  "Ready to close": "state-ready",
  Ready: "state-ready",
  "Merged · not closed": "state-merged",
  Merged: "state-merged",
  Archived: "state-idle",
  Offline: "state-idle",
};

export function stateColor(state) {
  return STATE_COLORS[state] ?? TOKENS.text2;
}

export function stateClass(state) {
  return STATE_CLASSES[state] ?? "state-idle";
}

// Short label for tight rows (navigator, compressed nodes).
export function stateShort(state) {
  if (state === "Ready to close") return "Ready";
  if (state === "Merged · not closed") return "Merged";
  return state;
}

export function esc(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function popcount(n) {
  let c = 0;
  let v = n;
  while (v) {
    c += v & 1;
    v >>>= 1;
  }
  return c;
}

// 8 bits, mirrored left-to-right into a 4x4 grid, so the mark reads as an
// identity sigil rather than noise. Clamped so no agent gets an almost empty
// or almost solid square.
export function sigilBits(name) {
  const h = hashName(name);
  let bits = (h ^ (h >>> 11)) & 0xff;
  if (popcount(bits) < 3) bits |= 0x93;
  if (popcount(bits) > 6) bits &= 0x6f;
  return bits;
}

// Deterministic 4x4 pixel mark, 16 rects, filled with the agent's hue.
export function sigil(name, hue, size = 12) {
  const bits = sigilBits(name);
  const color = hueColor(hue);
  const cell = size / 4;
  const pad = cell * 0.11;
  const side = (cell - pad * 2).toFixed(2);
  const rx = (cell * 0.22).toFixed(2);
  let rects = "";
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      const on = (bits >> (r * 2 + Math.min(c, 3 - c))) & 1;
      const x = (c * cell + pad).toFixed(2);
      const y = (r * cell + pad).toFixed(2);
      rects += `<rect x="${x}" y="${y}" width="${side}" height="${side}" rx="${rx}" fill="${color}" opacity="${on ? "1" : "0.13"}"></rect>`;
    }
  }
  return `<svg class="sigil" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${rects}</svg>`;
}

// One consistent stroke family: 16px box, stroke-width 1.5, round caps.
// %C is replaced with the resolved colour.
const ICONS = {
  crown: '<path d="M2.6 11.6 3.5 4.8 6.3 7.7 8 3.7 9.7 7.7 12.5 4.8 13.4 11.6Z"></path><path d="M4 13.5h8"></path>',
  eye: '<path d="M1.7 8C3.5 4.7 5.6 3.3 8 3.3s4.5 1.4 6.3 4.7c-1.8 3.3-3.9 4.7-6.3 4.7S3.5 11.3 1.7 8Z"></path><circle cx="8" cy="8" r="2.1"></circle>',
  pencil: '<path d="m11.1 2.9 2 2-7.5 7.5-2.8.8.8-2.8Z"></path><path d="m9.9 4.1 2 2"></path>',
  question: '<circle cx="8" cy="8" r="6.2"></circle><path d="M6.1 6.3a1.95 1.95 0 1 1 1.9 2.4v1"></path><path d="M8 12.1h.01"></path>',
  x: '<path d="m4.4 4.4 7.2 7.2"></path><path d="m11.6 4.4-7.2 7.2"></path>',
  check: '<path d="m3.4 8.4 3.2 3.2 6-6.8"></path>',
  merge: '<circle cx="4.7" cy="3.9" r="1.7"></circle><circle cx="4.7" cy="12.1" r="1.7"></circle><circle cx="11.3" cy="7.4" r="1.7"></circle><path d="M4.7 5.6v4.8"></path><path d="M4.7 6.2c0 2.4 2.1 1.2 4.9 1.2"></path>',
  "chevron-down": '<path d="m4.4 6.4 3.6 3.6 3.6-3.6"></path>',
  "chevron-right": '<path d="m6.4 4.4 3.6 3.6-3.6 3.6"></path>',
  stop: '<rect x="5.2" y="5.2" width="5.6" height="5.6" rx="1.3"></rect>',
  fit: '<path d="M3 6.2V3.7c0-.4.3-.7.7-.7h2.5"></path><path d="M9.8 3h2.5c.4 0 .7.3.7.7v2.5"></path><path d="M13 9.8v2.5c0 .4-.3.7-.7.7H9.8"></path><path d="M6.2 13H3.7c-.4 0-.7-.3-.7-.7V9.8"></path>',
  minus: '<path d="M4 8h8"></path>',
  plus: '<path d="M8 4v8"></path><path d="M4 8h8"></path>',
  dot: '<circle cx="8" cy="8" r="2.8" fill="%C" stroke="none"></circle>',
  clock: '<circle cx="8" cy="8" r="5.8"></circle><path d="M8 4.9V8l2.1 1.6"></path>',
  "arrow-up": '<path d="M8 12.6V3.9"></path><path d="m4.4 7.5 3.6-3.6 3.6 3.6"></path>',
};

export function icon(name, size = 12, color = "currentColor") {
  const body = ICONS[name];
  if (!body) throw new Error(`unknown icon: ${name}`);
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body.replaceAll("%C", color)}</svg>`;
}

export const ICON_NAMES = Object.keys(ICONS);
