import {
  BLOCK_TYPES, DEFAULT_CLIMB, MAX_PARTS, RideController, blockDuration, climbGrade, expandWorkout, fmtTime,
  errorText, newBlock, newPart, normalizeBlock, totalDuration, validateBlock, validateClimb,
} from "./core.js?v=4";
import { KickrBle, SimKickr, bluetoothSupport, isIos } from "./ble.js?v=4";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "kickr.workouts.v1";
const DRAFT_KEY = "kickr.draft.v1";
const CLIP_KEY = "kickr.clipboard.v1";
const params = new URLSearchParams(location.search);
const SPEED = Math.max(1, Number(params.get("zeitraffer")) || 1); // nur zum Testen

const EXAMPLE = {
  name: "Beispiel: Rampe und 10×30/10",
  blocks: [
    { type: "steady", name: "Warmfahren", durationS: 20 * 60, watts: 180 },
    { type: "ramp", name: "Steigern", durationS: 10 * 60, fromW: 180, toW: 220 },
    { type: "intervals", name: "Intervalle", repeats: 10,
      parts: [{ durationS: 30, watts: 400, name: "Belastung" }, { durationS: 10, watts: 200, name: "Erholung" }] },
    { type: "steady", name: "Pause", durationS: 10 * 60, watts: 130 },
  ],
  climb: { ...DEFAULT_CLIMB },
};

let workout = loadDraft() ?? structuredClone(EXAMPLE);
let trainer = null;
let ctrl = null;
let wakeLock = null;
let clipboard = loadClipboard(); // kopierter Block, bleibt auch für andere Trainings erhalten

// ---------------------------------------------------------------- Speicher (nur dieses Gerät)

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    return true;
  } catch (err) {
    showWoMsg(`Speichern nicht möglich: ${errorText(err)}`, true);
    return false;
  }
}

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    return d && Array.isArray(d.blocks) && d.climb ? d : null;
  } catch {
    return null;
  }
}

function loadClipboard() {
  try {
    const b = JSON.parse(localStorage.getItem(CLIP_KEY) || "null");
    return b && typeof b.type === "string" ? normalizeBlock(b) : null;
  } catch {
    return null;
  }
}

function saveClipboard() {
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(clipboard)); } catch { /* nur im Speicher */ }
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(workout)); } catch { /* privates Fenster: Entwurf nur im Speicher */ }
}

function showWoMsg(text, isError = false) {
  const el = $("wo-msg");
  el.textContent = text;
  el.style.color = isError ? "var(--warn)" : "";
}

function renderSavedList() {
  const store = readStore();
  const sel = $("wo-saved");
  sel.innerHTML = "";
  const first = new Option(Object.keys(store).length ? "– laden –" : "– noch keine –", "");
  sel.add(first);
  for (const name of Object.keys(store).sort((a, b) => a.localeCompare(b, "de"))) sel.add(new Option(name, name));
}

// ---------------------------------------------------------------- Baukasten

function num(value) {
  if (typeof value !== "string" || value.trim() === "") return NaN;
  return Number(value.replace(",", "."));
}

function field(label, value, onInput, { step = "1", unit = "", mode = "numeric" } = {}) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.inputMode = mode;
  input.step = step;
  input.value = Number.isFinite(value) ? String(value) : "";
  input.addEventListener("input", () => onInput(num(input.value), input));
  wrap.append(input);
  if (unit) {
    const u = document.createElement("span");
    u.className = "unit";
    u.textContent = unit;
    wrap.append(u);
  }
  return wrap;
}

/** Zwei Felder Minuten + Sekunden für eine Dauer in Sekunden. */
function durationFields(prefix, seconds, onChange) {
  let min = Math.floor((seconds || 0) / 60);
  let sec = Math.round((seconds || 0) - min * 60);
  const update = () => onChange((Number.isFinite(min) ? min : NaN) * 60 + (Number.isFinite(sec) ? sec : 0));
  return [
    field(`${prefix} min`, min, (v) => { min = v; update(); }),
    field(`${prefix} s`, sec, (v) => { sec = Number.isFinite(v) ? v : 0; update(); }),
  ];
}

function blockColor(block) {
  const w = block.type === "intervals" ? Math.max(...block.parts.map((p) => p.watts)) : block.type === "ramp" ? Math.max(block.fromW, block.toW) : block.watts;
  if (w >= 350) return "#c92a2a";
  if (w >= 250) return "#e8590c";
  if (w >= 180) return "#f59f00";
  return "#2b8a3e";
}

function renderBlocks() {
  const list = $("blocks");
  list.innerHTML = "";
  workout.blocks.forEach((block, i) => list.append(renderBlock(block, i)));
}

function renderBlock(block, i) {
  const card = document.createElement("div");
  card.className = "card block";
  card.style.borderLeftColor = blockColor(block);

  const head = document.createElement("div");
  head.className = "block-head";
  const type = document.createElement("select");
  for (const [key, label] of Object.entries(BLOCK_TYPES)) type.add(new Option(label, key, false, key === block.type));
  type.addEventListener("change", () => {
    const fresh = newBlock(type.value);
    workout.blocks[i] = { ...fresh, name: block.name || fresh.name };
    changed(true);
  });
  const name = document.createElement("input");
  name.type = "text";
  name.value = block.name ?? "";
  name.placeholder = "Bezeichnung";
  name.addEventListener("input", () => { block.name = name.value; changed(false); });
  const mk = (text, title, fn, disabled = false) => {
    const b = document.createElement("button");
    b.className = "btn icon";
    b.textContent = text;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener("click", fn);
    return b;
  };
  const tools = document.createElement("div");
  tools.className = "tools";
  tools.append(
    mk("↑", "nach oben", () => move(i, -1), i === 0),
    mk("↓", "nach unten", () => move(i, +1), i === workout.blocks.length - 1),
    mk("⧉", "direkt darunter duplizieren", () => { workout.blocks.splice(i + 1, 0, structuredClone(block)); changed(true); }),
    mk("Kopieren", "kopieren, um ihn später mit „Einfügen“ wieder einzusetzen", () => copyBlock(block)),
    mk("✕", "löschen", () => { workout.blocks.splice(i, 1); changed(true); }),
  );
  head.append(type, name, tools);

  const body = document.createElement("div");
  body.className = "block-body";
  const set = (key) => (v) => { block[key] = v; changed(false, card, block); };
  if (block.type === "steady") {
    body.append(...durationFields("Dauer", block.durationS, set("durationS")), field("Watt", block.watts, set("watts")));
  } else if (block.type === "ramp") {
    body.append(...durationFields("Dauer", block.durationS, set("durationS")),
      field("von Watt", block.fromW, set("fromW")), field("bis Watt", block.toW, set("toW")));
  } else {
    body.append(field("Wiederholungen", block.repeats, set("repeats")), partsCountField(block));
    block.parts.forEach((part, k) => body.append(renderPart(block, part, k, card)));
  }

  const foot = document.createElement("div");
  foot.className = "block-foot";
  card.append(head, body, foot);
  updateBlockFoot(card, block);
  return card;
}

/** Anzahl Teile pro Durchgang. Ändert die Kartenstruktur, daher erst beim Verlassen des Felds. */
function partsCountField(block) {
  const wrap = field("Teile pro Durchgang", block.parts.length, () => {}, {});
  const input = wrap.querySelector("input");
  input.min = "1";
  input.max = String(MAX_PARTS);
  input.addEventListener("change", () => {
    const n = num(input.value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) {
      input.classList.add("invalid");
      return;
    }
    while (block.parts.length < n) {
      const last = block.parts[block.parts.length - 1];
      block.parts.push(newPart(last?.durationS ?? 60, last?.watts ?? 200));
    }
    block.parts.length = n;
    changed(true);
  });
  return wrap;
}

function renderPart(block, part, k, card) {
  const row = document.createElement("div");
  row.className = "part";
  const nameWrap = document.createElement("label");
  nameWrap.className = "field";
  nameWrap.textContent = `Teil ${k + 1}`;
  const name = document.createElement("input");
  name.type = "text";
  name.value = part.name ?? "";
  name.placeholder = `Teil ${k + 1}`;
  name.addEventListener("input", () => { part.name = name.value; changed(false, card, block); });
  nameWrap.append(name);
  const set = (key) => (v) => { part[key] = v; changed(false, card, block); };
  row.append(nameWrap, ...durationFields("", part.durationS, set("durationS")), field("Watt", part.watts, set("watts")));
  return row;
}

function copyBlock(block) {
  clipboard = structuredClone(block);
  saveClipboard();
  renderPasteButton();
  showWoMsg(`„${block.name || BLOCK_TYPES[block.type]}“ kopiert. Unten mit „Einfügen“ ans Ende setzen.`);
}

function renderPasteButton() {
  const btn = $("paste-block");
  btn.classList.toggle("hidden", !clipboard);
  if (clipboard) btn.textContent = `Einfügen: ${clipboard.name || BLOCK_TYPES[clipboard.type]} (${fmtTime(blockDuration(clipboard))})`;
}

function blockSummary(block) {
  if (block.type !== "intervals") return `Dauer ${fmtTime(blockDuration(block))}`;
  const one = block.parts.map((p) => `${fmtTime(p.durationS)} ${p.watts} W`).join(" · ");
  return `${block.repeats} × (${one}) = ${fmtTime(blockDuration(block))}`;
}

function updateBlockFoot(card, block) {
  const foot = card.querySelector(".block-foot");
  const errors = validateBlock(block);
  card.style.borderLeftColor = blockColor(block);
  foot.innerHTML = "";
  if (errors.length) {
    const e = document.createElement("span");
    e.className = "err";
    e.textContent = errors.join(" · ");
    foot.append(e);
  } else {
    foot.textContent = blockSummary(block);
  }
}

function move(i, dir) {
  const [b] = workout.blocks.splice(i, 1);
  workout.blocks.splice(i + dir, 0, b);
  changed(true);
}

/** structural = Karten neu aufbauen (verliert Fokus), sonst nur Diagramm/Fußzeile. */
function changed(structural, card = null, block = null) {
  if (structural) renderBlocks();
  if (card && block) updateBlockFoot(card, block);
  renderBuildChart();
  saveDraft();
}

// ---------------------------------------------------------------- Diagramm

const W = 1000;
const H = 300;
const PAD = { l: 64, r: 52, t: 14, b: 40 };

function svgEl(tag, attrs, text) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

function drawChart(svg, steps, climb, position = null) {
  svg.innerHTML = "";
  const total = totalDuration(steps);
  if (!total) return;
  const maxW = Math.max(100, ...steps.flatMap((s) => [s.startW, s.endW])) * 1.1;
  const maxG = Math.max(climb.maxPct, 1) * 1.15;
  const minG = Math.min(climb.minPct, 0);
  const x = (t) => PAD.l + (t / total) * (W - PAD.l - PAD.r);
  const y = (w) => H - PAD.b - (w / maxW) * (H - PAD.t - PAD.b);
  const yg = (g) => H - PAD.b - ((g - minG) / (maxG - minG)) * (H - PAD.t - PAD.b);

  const wStep = maxW > 600 ? 200 : 100;
  for (let w = wStep; w < maxW; w += wStep) {
    svg.append(svgEl("line", { x1: PAD.l, x2: W - PAD.r, y1: y(w), y2: y(w), class: "grid" }));
    svg.append(svgEl("text", { x: PAD.l - 8, y: y(w) + 7, "text-anchor": "end" }, `${w}`));
  }
  const tStep = [300, 600, 900, 1800, 3600].find((s) => total / s <= 8) ?? 7200;
  for (let t = 0; t <= total; t += tStep) {
    svg.append(svgEl("text", { x: x(t), y: H - 10, "text-anchor": "middle" }, fmtTime(t)));
  }

  let d = `M ${x(0)} ${y(0)}`;
  let t = 0;
  for (const s of steps) {
    d += ` L ${x(t)} ${y(s.startW)} L ${x(t + s.durationS)} ${y(s.endW)}`;
    t += s.durationS;
  }
  d += ` L ${x(total)} ${y(0)} Z`;
  svg.append(svgEl("path", { d, class: "area" }));

  if (position !== null) {
    const clip = svgEl("clipPath", { id: `${svg.id}-clip` });
    clip.append(svgEl("rect", { x: 0, y: 0, width: x(Math.min(position, total)), height: H }));
    svg.append(clip);
    svg.append(svgEl("path", { d, class: "done", "clip-path": `url(#${svg.id}-clip)` }));
  }

  if (climb.enabled) {
    let wave = "";
    const samples = 240;
    for (let i = 0; i <= samples; i++) {
      const tt = (i / samples) * total;
      wave += `${i ? "L" : "M"} ${x(tt)} ${yg(climbGrade(climb, tt))} `;
    }
    svg.append(svgEl("path", { d: wave, class: "wave" }));
    svg.append(svgEl("text", { x: W - PAD.r + 6, y: yg(climb.maxPct) + 7, fill: "var(--climb)" }, `${climb.maxPct}%`));
    svg.append(svgEl("text", { x: W - PAD.r + 6, y: yg(climb.minPct) + 7, fill: "var(--climb)" }, `${climb.minPct}%`));
  }

  if (position !== null) {
    svg.append(svgEl("line", { x1: x(position), x2: x(position), y1: PAD.t, y2: H - PAD.b, class: "cursor" }));
  }
}

function currentSteps() {
  try {
    return { steps: expandWorkout(workout.blocks), error: null };
  } catch (err) {
    return { steps: [], error: errorText(err) };
  }
}

function renderBuildChart() {
  const { steps, error } = currentSteps();
  const svg = $("build-chart");
  const summary = $("build-summary");
  summary.innerHTML = "";
  if (error) {
    svg.innerHTML = "";
    summary.innerHTML = `<span class="notice warn">${escapeHtml(error)}</span>`;
  } else {
    drawChart(svg, steps, workout.climb);
    const total = totalDuration(steps);
    const kj = steps.reduce((sum, s) => sum + ((s.startW + s.endW) / 2) * s.durationS, 0) / 1000;
    summary.innerHTML = `<span>Dauer <b>${fmtTime(total)}</b></span>`
      + `<span>Ø <b>${Math.round((kj * 1000) / total)} W</b></span>`
      + `<span>Arbeit <b>${Math.round(kj)} kJ</b></span>`
      + `<span class="legend-power">▬ Leistung</span>`
      + (workout.climb.enabled ? `<span class="legend-climb">┅ CLIMB</span>` : "");
  }
  renderClimbText();
}

function renderClimbText() {
  const c = workout.climb;
  const errors = validateClimb(c);
  const el = $("climb-text");
  el.style.color = errors.length ? "var(--warn)" : "";
  if (errors.length) el.textContent = errors.join(" · ");
  else if (!c.enabled) el.textContent = "CLIMB bleibt während des Trainings flach.";
  else el.textContent = `In ${c.minutesPerDirection} min von ${c.minPct} % auf ${c.maxPct} %, dann in ${c.minutesPerDirection} min zurück, immer weiter. Unabhängig von den Intervallen, steht in Pausen still.`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function loadIntoEditor(data) {
  workout = structuredClone(data);
  workout.blocks = workout.blocks.map(normalizeBlock);
  workout.climb = { ...DEFAULT_CLIMB, ...workout.climb };
  $("wo-name").value = workout.name ?? "";
  $("climb-on").checked = workout.climb.enabled;
  $("climb-min").value = workout.climb.minPct;
  $("climb-max").value = workout.climb.maxPct;
  $("climb-minutes").value = workout.climb.minutesPerDirection;
  renderBlocks();
  renderBuildChart();
  saveDraft();
}

function initBuild() {
  $("wo-name").addEventListener("input", (e) => { workout.name = e.target.value; saveDraft(); });
  for (const btn of document.querySelectorAll("[data-add]")) {
    btn.addEventListener("click", () => {
      workout.blocks.push(newBlock(btn.dataset.add));
      changed(true);
      $("blocks").lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
  $("paste-block").addEventListener("click", () => {
    if (!clipboard) return;
    workout.blocks.push(structuredClone(clipboard));
    changed(true);
    $("blocks").lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" });
    showWoMsg("Eingefügt.");
  });
  renderPasteButton();
  $("climb-on").addEventListener("change", (e) => { workout.climb.enabled = e.target.checked; changed(false); });
  const climbField = (id, key) => $(id).addEventListener("input", (e) => {
    workout.climb[key] = num(e.target.value);
    e.target.classList.toggle("invalid", validateClimb(workout.climb).length > 0);
    changed(false);
  });
  climbField("climb-min", "minPct");
  climbField("climb-max", "maxPct");
  climbField("climb-minutes", "minutesPerDirection");

  $("wo-save").addEventListener("click", () => {
    const name = ($("wo-name").value || "").trim();
    if (!name) return showWoMsg("Bitte zuerst einen Namen eingeben.", true);
    const store = readStore();
    store[name] = { ...structuredClone(workout), name };
    if (writeStore(store)) {
      renderSavedList();
      showWoMsg(`„${name}“ gespeichert (auf diesem Gerät).`);
    }
  });
  $("wo-saved").addEventListener("change", (e) => {
    const data = readStore()[e.target.value];
    if (data) {
      loadIntoEditor(data);
      showWoMsg(`„${e.target.value}“ geladen.`);
    }
    e.target.value = "";
  });
  $("wo-new").addEventListener("click", () => {
    loadIntoEditor({ name: "", blocks: [newBlock("warmup")], climb: workout.climb });
    showWoMsg("Neues Training.");
  });
  $("wo-delete").addEventListener("click", () => {
    const name = ($("wo-name").value || "").trim();
    const store = readStore();
    if (!store[name]) return showWoMsg("Dieses Training ist nicht gespeichert.", true);
    if (!confirm(`„${name}“ löschen?`)) return;
    delete store[name];
    if (writeStore(store)) {
      renderSavedList();
      showWoMsg(`„${name}“ gelöscht.`);
    }
  });
  $("go-ride").addEventListener("click", () => showTab("ride"));
  renderSavedList();
  loadIntoEditor(workout);
}

// ---------------------------------------------------------------- Ansicht

function showTab(which) {
  if (which === "build" && ctrl && !ctrl.done) return; // während der Fahrt nicht umbauen
  $("tab-build").setAttribute("aria-selected", which === "build");
  $("tab-ride").setAttribute("aria-selected", which === "ride");
  $("view-build").classList.toggle("hidden", which !== "build");
  $("view-ride").classList.toggle("hidden", which !== "ride");
  if (which === "ride") renderRideSetup();
  window.scrollTo(0, 0);
}

function setPill(text, kind) {
  const pill = $("conn-pill");
  pill.textContent = text;
  pill.className = `pill ${kind ?? ""}`;
}

function setConnStatus(text, kind = "") {
  const el = $("conn-status");
  el.textContent = text;
  el.className = `notice ${kind}`;
}

function renderRideSetup() {
  const { steps, error } = currentSteps();
  const climbErrors = validateClimb(workout.climb);
  const el = $("ride-summary");
  if (error || climbErrors.length) {
    el.innerHTML = `<div class="notice warn">${escapeHtml(error || climbErrors[0])}. Bitte im Tab „Training“ korrigieren.</div>`;
  } else {
    const c = workout.climb;
    el.innerHTML = `<div><b>${escapeHtml(workout.name || "Ohne Namen")}</b> · ${fmtTime(totalDuration(steps))} · ${workout.blocks.length} Blöcke</div>`
      + `<div class="muted">CLIMB: ${c.enabled ? `${c.minPct}–${c.maxPct} %, ${c.minutesPerDirection} min pro Richtung` : "aus"}</div>`;
  }
  $("btn-start").disabled = Boolean(error || climbErrors.length || !trainer?.connected);
}

// ---------------------------------------------------------------- Verbindung

function onTrainerEvent(ev) {
  if (ev.type === "power") {
    $("conn-power").textContent = `Leistung live: ${ev.watts} W`;
    return;
  }
  if (ev.type === "status") {
    setConnStatus(ev.text, trainer?.connected ? "ok" : "");
    if (trainer?.connected) setPill(trainer.name, "ok");
  } else if (ev.type === "warning") {
    setConnStatus(ev.text, "warn");
  } else if (ev.type === "disconnected") {
    setPill("getrennt", "warn");
    setConnStatus(`${ev.text}.${ctrl && !ctrl.done ? " Verbinde neu …" : " Erneut auf „verbinden“ tippen."}`, "warn");
    $("btn-connect").disabled = false;
  }
  renderRideSetup();
}

async function connect() {
  const sim = $("sim-mode").checked;
  const problem = sim ? null : bluetoothSupport();
  if (problem) {
    setConnStatus("In diesem Browser geht Bluetooth nicht, siehe Hinweis oben.", "warn");
    $("bt-support").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  $("btn-connect").disabled = true;
  try {
    if (!trainer || (sim !== trainer instanceof SimKickr)) {
      trainer = sim ? new SimKickr(onTrainerEvent) : new KickrBle(onTrainerEvent);
    }
    if (!sim && !trainer.device) {
      setConnStatus("Suche KICKR … bitte im Fenster auswählen.");
      await trainer.select();
    }
    setPill("verbinde …");
    await trainer.connect();
    setPill(trainer.name, "ok");
    if (sim) $("conn-power").textContent = "Simulator: Ist-Leistung = Soll-Leistung";
  } catch (err) {
    const text = err.name === "NotFoundError"
      ? "Kein KICKR ausgewählt. Taucht er nicht auf: kurz treten (aufwecken), Zwift/Wahoo-App schließen, Bluetooth und Standort am Gerät an?"
      : errorText(err);
    console.error("Verbindung fehlgeschlagen", err);
    // Beim nächsten Tippen wieder das Auswahlfenster zeigen, falls das falsche Gerät gewählt wurde.
    if (trainer instanceof KickrBle && !trainer.connected) {
      trainer.closing = true; // keine "getrennt"-Meldung über die Fehlermeldung schreiben
      if (trainer.device?.gatt?.connected) trainer.device.gatt.disconnect();
      trainer = new KickrBle(onTrainerEvent);
    }
    setConnStatus(`Verbindung fehlgeschlagen: ${text}`, "warn");
    setPill("nicht verbunden", "warn");
  } finally {
    $("btn-connect").disabled = false;
    $("btn-connect").textContent = trainer?.connected ? "Neu verbinden" : "KICKR suchen und verbinden";
    renderRideSetup();
  }
}

// ---------------------------------------------------------------- Fahrt

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ctrl && !ctrl.done) requestWakeLock();
});

window.addEventListener("beforeunload", (e) => {
  if (ctrl && !ctrl.done) {
    e.preventDefault();
    e.returnValue = "";
  }
});

async function startRide() {
  const { steps, error } = currentSteps();
  if (error || !trainer?.connected) return;
  ctrl = new RideController(steps, structuredClone(workout.climb), trainer);
  $("ride-setup").classList.add("hidden");
  $("ride-end").classList.add("hidden");
  $("ride-live").classList.remove("hidden");
  $("sim-pedal-row").classList.toggle("hidden", !(trainer instanceof SimKickr));
  $("tab-build").disabled = true;
  await requestWakeLock();
  if (!wakeLock) $("step-next").textContent = "Hinweis: Bildschirm-Sperre im Gerät ausschalten, sonst stoppt das Training.";

  let last = performance.now();
  while (!ctrl.done) {
    const t0 = performance.now();
    const dt = ((t0 - last) / 1000) * SPEED;
    last = t0;
    if (trainer instanceof SimKickr) {
      trainer.pedaling = $("sim-pedal").checked;
      trainer.tickPower();
    }
    await ctrl.tick(dt);
    renderRide();
    await sleep(Math.max(0, 1000 / SPEED - (performance.now() - t0)));
  }
  renderRide();
  endRide();
}

function renderRide() {
  const s = ctrl.session;
  const banner = $("banner");
  const states = {
    riding: ["", ""],
    autopause: s.totalElapsed < 1 ? ["Tritt los, dann startet das Training", "pause"] : ["Pause – einfach weitertreten, dann geht es weiter", "pause"],
    paused: ["Pausiert – „Weiter“ tippen", "pause"],
    reconnecting: [ctrl.message, "warn"],
    failed: [ctrl.message, "warn"],
    finished: ["Geschafft!", "ok"],
    stopped: ["Beendet", "ok"],
  };
  const [text, kind] = states[ctrl.state] ?? ["", ""];
  banner.textContent = text || s.step?.label || "";
  banner.className = `banner ${kind}`;

  const step = s.step;
  $("step-now").textContent = step ? step.label : "Fertig";
  const next = s.nextStep;
  if (wakeLock || !step) {
    $("step-next").textContent = next ? `Danach: ${next.label} · ${fmtTime(next.durationS)} @ ${Math.round(next.startW)}${next.endW !== next.startW ? `→${Math.round(next.endW)}` : ""} W` : step ? "Danach: Ende" : "";
  }
  $("t-target").textContent = s.targetWatts();
  $("t-intensity").textContent = s.intensityPct === 100 ? "W" : `W · Intensität ${s.intensityPct} %`;
  const stale = trainer.powerAvailable && trainer.powerAgeS() > 5;
  $("t-power").textContent = !trainer.powerAvailable ? "?" : stale ? "–" : trainer.powerW;
  $("t-remaining").textContent = fmtTime(s.stepRemaining);
  $("t-next-in").textContent = `gesamt ${fmtTime(s.position)} / ${fmtTime(totalDuration(s.steps))}`;
  $("t-grade").textContent = trainer.gradeSent === null ? "–" : trainer.gradeSent.toFixed(1);
  $("t-grade-target").textContent = ctrl.climb.enabled ? `% · Ziel ${ctrl.gradeTarget.toFixed(1)} %` : "% · aus";
  $("btn-pause").textContent = ctrl.manualPause ? "Weiter" : "Pause";
  drawChart($("ride-chart"), s.steps, ctrl.climb, s.position);
  $("ride-progress").innerHTML = `<span>Gefahren <b>${fmtTime(s.totalElapsed)}</b></span>`
    + (trainer.rejections ? `<span class="notice warn">KICKR hat ${trainer.rejections} Befehl(e) abgelehnt</span>` : "");
}

function endRide() {
  try { wakeLock?.release(); } catch { /* bereits freigegeben */ }
  wakeLock = null;
  $("tab-build").disabled = false;
  $("ride-live").classList.add("hidden");
  $("ride-end").classList.remove("hidden");
  const s = ctrl.session;
  const ok = ctrl.state === "finished";
  $("end-banner").textContent = ok ? "Training geschafft!" : ctrl.state === "failed" ? "Training abgebrochen" : "Training beendet";
  $("end-banner").className = `banner ${ok ? "ok" : ctrl.state === "failed" ? "warn" : "pause"}`;
  const climbText = ctrl.climbReset
    ? "CLIMB steht wieder auf 0 %."
    : "<b>CLIMB-Rückstellung nicht bestätigt</b> – bitte den CLIMB mit seinen Lenkertasten auf 0 % stellen.";
  $("end-text").innerHTML = `<div>Gefahren: <b>${fmtTime(s.totalElapsed)}</b> von ${fmtTime(totalDuration(s.steps))}</div>`
    + `<div class="notice ${ctrl.climbReset ? "ok" : "warn"}">${climbText}</div>`
    + (ctrl.state === "failed" ? `<div class="notice warn">${escapeHtml(ctrl.message)}</div>` : "")
    + `<p class="muted">Aufzeichnung auf der Uhr/dem Edge jetzt beenden und speichern.</p>`;
  setPill("getrennt");
  setConnStatus("Nach dem Training getrennt. Für ein neues Training erneut verbinden.");
  $("btn-connect").textContent = "KICKR suchen und verbinden";
}

function initRide() {
  const problem = bluetoothSupport();
  if (problem) {
    $("bt-support").textContent = problem;
    $("bt-support").classList.remove("hidden");
    if (isIos()) {
      // Adresse für Bluefy bereitstellen: kopieren und dort einfügen.
      const copy = document.createElement("button");
      copy.className = "btn";
      copy.style.marginTop = "8px";
      copy.textContent = "Adresse kopieren (zum Einfügen in Bluefy)";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(location.origin + location.pathname);
          copy.textContent = "Kopiert ✓ – jetzt Bluefy öffnen und in die Adresszeile einfügen";
        } catch {
          copy.textContent = location.origin + location.pathname;
        }
      });
      $("bt-support").append(document.createElement("br"), copy);
    }
  }
  $("btn-connect").addEventListener("click", connect);
  $("sim-mode").addEventListener("change", renderRideSetup);
  $("btn-start").addEventListener("click", startRide);
  $("btn-pause").addEventListener("click", () => { ctrl?.togglePause(); renderRide(); });
  $("btn-skip").addEventListener("click", () => { ctrl?.skip(); renderRide(); });
  $("btn-plus").addEventListener("click", () => { ctrl?.session.changeIntensity(+1); renderRide(); });
  $("btn-minus").addEventListener("click", () => { ctrl?.session.changeIntensity(-1); renderRide(); });
  $("btn-stop").addEventListener("click", async () => {
    if (ctrl && !ctrl.done && confirm("Training wirklich beenden?")) await ctrl.stop();
  });
  $("btn-again").addEventListener("click", () => {
    $("ride-end").classList.add("hidden");
    $("ride-setup").classList.remove("hidden");
    ctrl = null;
    showTab("build");
  });
  $("tab-build").addEventListener("click", () => showTab("build"));
  $("tab-ride").addEventListener("click", () => showTab("ride"));
}

initBuild();
initRide();
