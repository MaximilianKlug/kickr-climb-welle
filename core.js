// Kernlogik ohne Browser-APIs: Trainingsaufbau, Zeitablauf, CLIMB-Welle, Fahrsteuerung.
// Portiert aus kickr/session.py und kickr/grade.py, damit Python- und Web-Version gleich ticken.

export const CLIMB_MIN = -10;
export const CLIMB_MAX = 20;
export const MAX_WATTS = 2000;
export const MAX_STEPS = 10000;
export const MAX_BLOCK_S = 6 * 3600;

export const DEFAULT_CLIMB = { enabled: true, minPct: 0, maxPct: 6, minutesPerDirection: 5 };

export const RIDE = {
  autoPauseWatts: 15,
  autoPauseDelayS: 2,     // erst nach 2 s unter der Schwelle pausieren (kein Flackern bei Tretpausen)
  powerStaleS: 5,         // ohne Leistungsdaten länger als 5 s gilt: nicht getreten
  ergRefreshS: 10,
  gradeMinChange: 0.5,
  gradeMinGapS: 3,
  gradeIntervalS: 10,
  intensityStepPct: 5,
  maxReconnectCycles: 3,
};

/**
 * Lesbarer Fehlertext. Manche Browser (z. B. Bluefy auf dem iPad) werfen Strings, Objekte
 * oder Fehler ohne message, dann stand vorher nur "undefined" da.
 */
export function errorText(err) {
  if (err === null || err === undefined) return "unbekannter Fehler";
  if (typeof err === "string") return err || "unbekannter Fehler";
  const message = typeof err.message === "string" ? err.message.trim() : "";
  const name = typeof err.name === "string" && err.name !== "Error" ? err.name : "";
  const text = [name, message].filter(Boolean).join(": ");
  if (text) return text;
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch { /* zyklisch o. Ä. */ }
  const plain = String(err);
  return plain && plain !== "[object Object]" ? plain : "unbekannter Fehler (ohne Beschreibung)";
}

export function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

export function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(r).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- Trainingsaufbau

export const BLOCK_TYPES = {
  steady: "Konstant",
  ramp: "Rampe",
  intervals: "Intervalle",
};

export const MAX_PARTS = 20;

/** Ein Teil eines Intervalls, z. B. 1 min 200 W. */
export function newPart(durationS = 60, watts = 200, name = "") {
  return { durationS, watts, name };
}

/**
 * Bringt ältere Blöcke auf das aktuelle Format. Intervalle hatten früher genau zwei feste Teile
 * (onS/onW, offS/offW), jetzt eine Liste parts mit beliebig vielen Teilen.
 */
export function normalizeBlock(block) {
  if (block?.type !== "intervals" || Array.isArray(block.parts)) return block;
  const { onS, onW, offS, offW, ...rest } = block;
  const parts = [newPart(onS, onW, "Belastung")];
  if (offS > 0) parts.push(newPart(offS, offW, "Erholung"));
  return { ...rest, parts };
}

export function newBlock(type) {
  switch (type) {
    case "warmup":
      return { type: "ramp", name: "Einfahren", durationS: 10 * 60, fromW: 120, toW: 180 };
    case "ramp":
      return { type: "ramp", name: "Rampe", durationS: 10 * 60, fromW: 180, toW: 220 };
    case "intervals":
      return { type: "intervals", name: "Intervalle", repeats: 10,
        parts: [newPart(30, 400, "Belastung"), newPart(10, 200, "Erholung")] };
    case "recovery":
      return { type: "steady", name: "Erholung", durationS: 5 * 60, watts: 120 };
    default:
      return { type: "steady", name: "Konstant", durationS: 20 * 60, watts: 180 };
  }
}

function checkNumber(value, lo, hi, what) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < lo || value > hi) {
    return `${what} muss zwischen ${lo} und ${hi} liegen`;
  }
  return null;
}

/** Gibt eine Liste von Fehlertexten für einen Block zurück (leer = in Ordnung). */
export function validateBlock(rawBlock) {
  const block = normalizeBlock(rawBlock);
  const errors = [];
  const add = (e) => e && errors.push(e);
  if (block.type === "steady") {
    add(checkNumber(block.durationS, 1, MAX_BLOCK_S, "Dauer (s)"));
    add(checkNumber(block.watts, 0, MAX_WATTS, "Leistung (W)"));
  } else if (block.type === "ramp") {
    add(checkNumber(block.durationS, 1, MAX_BLOCK_S, "Dauer (s)"));
    add(checkNumber(block.fromW, 0, MAX_WATTS, "Start (W)"));
    add(checkNumber(block.toW, 0, MAX_WATTS, "Ziel (W)"));
  } else if (block.type === "intervals") {
    add(checkNumber(block.repeats, 1, 500, "Wiederholungen"));
    if (!Number.isInteger(block.repeats)) errors.push("Wiederholungen müssen eine ganze Zahl sein");
    if (!Array.isArray(block.parts) || block.parts.length < 1 || block.parts.length > MAX_PARTS) {
      errors.push(`Ein Intervall braucht 1 bis ${MAX_PARTS} Teile`);
    } else {
      block.parts.forEach((part, k) => {
        add(checkNumber(part.durationS, 1, MAX_BLOCK_S, `Teil ${k + 1}: Dauer (s)`));
        add(checkNumber(part.watts, 0, MAX_WATTS, `Teil ${k + 1}: Leistung (W)`));
      });
    }
  } else {
    errors.push(`Unbekannter Blocktyp '${block.type}'`);
  }
  return errors;
}

export function validateClimb(climb) {
  const errors = [];
  const add = (e) => e && errors.push(e);
  add(checkNumber(climb.minPct, CLIMB_MIN, CLIMB_MAX, "CLIMB von (%)"));
  add(checkNumber(climb.maxPct, CLIMB_MIN, CLIMB_MAX, "CLIMB bis (%)"));
  add(checkNumber(climb.minutesPerDirection, 0.5, 120, "Minuten pro Richtung"));
  if (!errors.length && climb.minPct > climb.maxPct) errors.push("CLIMB: 'von' muss kleiner oder gleich 'bis' sein");
  return errors;
}

/** Macht aus den Bausteinen eine flache Schrittliste. Wirft Error bei ungültigen Blöcken. */
export function expandWorkout(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error("Das Training hat noch keine Blöcke");
  const steps = [];
  blocks.forEach((rawBlock, index) => {
    const block = normalizeBlock(rawBlock);
    const errors = validateBlock(block);
    if (errors.length) throw new Error(`Block ${index + 1} (${block.name || BLOCK_TYPES[block.type] || "?"}): ${errors[0]}`);
    const name = (block.name || BLOCK_TYPES[block.type]).trim();
    if (block.type === "steady") {
      steps.push({ durationS: block.durationS, startW: block.watts, endW: block.watts, label: name, blockIndex: index });
    } else if (block.type === "ramp") {
      steps.push({ durationS: block.durationS, startW: block.fromW, endW: block.toW, label: name, blockIndex: index });
    } else {
      const n = block.parts.length;
      if (steps.length + block.repeats * n > MAX_STEPS) throw new Error(`Block ${index + 1}: zu viele Wiederholungen`);
      for (let i = 1; i <= block.repeats; i++) {
        const tag = `${name} ${i}/${block.repeats}`;
        block.parts.forEach((part, k) => {
          const partName = (part.name || "").trim() || `Teil ${k + 1}/${n}`;
          steps.push({ durationS: part.durationS, startW: part.watts, endW: part.watts, label: `${tag} ${partName}`, blockIndex: index });
        });
      }
    }
  });
  return steps;
}

export function blockDuration(rawBlock) {
  const block = normalizeBlock(rawBlock);
  if (block.type === "intervals") return block.repeats * block.parts.reduce((sum, p) => sum + p.durationS, 0);
  return block.durationS;
}

export function totalDuration(steps) {
  return steps.reduce((sum, s) => sum + s.durationS, 0);
}

export function targetAt(step, t) {
  if (step.startW === step.endW || step.durationS <= 0) return step.startW;
  return step.startW + (step.endW - step.startW) * clamp(t / step.durationS, 0, 1);
}

// ---------------------------------------------------------------- CLIMB-Welle

export function triangle(t, periodS) {
  const frac = (((t % periodS) + periodS) % periodS) / periodS;
  return frac < 0.5 ? 2 * frac : 2 - 2 * frac;
}

/** Neigung in % zur Trainingszeit t: startet bei minPct, erreicht maxPct nach minutesPerDirection. */
export function climbGrade(climb, t) {
  if (!climb.enabled) return 0;
  const period = climb.minutesPerDirection * 120;
  const grade = climb.minPct + triangle(t, period) * (climb.maxPct - climb.minPct);
  return Math.round(clamp(grade, CLIMB_MIN, CLIMB_MAX) * 10) / 10;
}

export class GradeSendPolicy {
  constructor(cfg = RIDE) {
    this.cfg = cfg;
    this.lastGrade = null;
    this.lastTime = 0;
  }

  shouldSend(grade, now) {
    if (this.lastGrade === null) return true;
    const delta = Math.abs(grade - this.lastGrade);
    if (delta < 0.05) return false;
    const gap = now - this.lastTime;
    if (gap < this.cfg.gradeMinGapS) return false;
    return delta >= this.cfg.gradeMinChange || gap >= this.cfg.gradeIntervalS;
  }

  markSent(grade, now) {
    this.lastGrade = grade;
    this.lastTime = now;
  }

  reset() {
    this.lastGrade = null;
  }
}

// ---------------------------------------------------------------- Zeitablauf

export class Session {
  constructor(steps) {
    this.steps = steps;
    this.stepIndex = 0;
    this.stepElapsed = 0;
    this.totalElapsed = 0;
    this.intensityPct = 100;
  }

  get finished() {
    return this.stepIndex >= this.steps.length;
  }

  get step() {
    return this.finished ? null : this.steps[this.stepIndex];
  }

  get nextStep() {
    return this.steps[this.stepIndex + 1] ?? null;
  }

  get stepRemaining() {
    return this.step ? Math.max(this.step.durationS - this.stepElapsed, 0) : 0;
  }

  /** Position im Training (für Fortschrittsanzeige), unabhängig von übersprungenen Schritten. */
  get position() {
    let pos = 0;
    for (let i = 0; i < Math.min(this.stepIndex, this.steps.length); i++) pos += this.steps[i].durationS;
    return pos + this.stepElapsed;
  }

  advance(dt) {
    this.totalElapsed += dt;
    this.stepElapsed += dt;
    while (!this.finished && this.stepElapsed >= this.steps[this.stepIndex].durationS) {
      this.stepElapsed -= this.steps[this.stepIndex].durationS;
      this.stepIndex += 1;
    }
    if (this.finished) {
      this.totalElapsed -= this.stepElapsed; // Überhang des letzten Takts nicht mitzählen
      this.stepElapsed = 0;
    }
  }

  skip() {
    if (!this.finished) {
      this.stepIndex += 1;
      this.stepElapsed = 0;
    }
  }

  changeIntensity(direction, stepPct = RIDE.intensityStepPct) {
    this.intensityPct = clamp(this.intensityPct + direction * stepPct, 50, 150);
  }

  targetWatts() {
    const step = this.step;
    if (!step) return 0;
    return clamp(Math.round((targetAt(step, this.stepElapsed) * this.intensityPct) / 100), 0, MAX_WATTS);
  }
}

// ---------------------------------------------------------------- Fahrsteuerung

/**
 * Steuert eine Fahrt. Der Aufrufer ruft tick(dt) etwa einmal pro Sekunde auf (dt in Sekunden,
 * echte Zeit). trainer muss bieten: connected, powerAvailable, powerW, powerAgeS(), controlLost,
 * setPower(w), setGrade(g, w), reconnect(), close().
 */
export class RideController {
  constructor(steps, climb, trainer, cfg = RIDE) {
    this.session = new Session(steps);
    this.climb = climb;
    this.trainer = trainer;
    this.cfg = cfg;
    this.policy = new GradeSendPolicy(cfg);
    this.clock = 0;
    this.lastPedalClock = -Infinity;
    this.sentPower = null;
    this.lastErgClock = -Infinity;
    this.gradeTarget = climbGrade(climb, 0);
    this.manualPause = false;
    this.state = "ready"; // ready | riding | autopause | paused | reconnecting | finished | stopped | failed
    this.failedCycles = 0;
    this.message = "";
  }

  get done() {
    return ["finished", "stopped", "failed"].includes(this.state);
  }

  isPedaling() {
    const t = this.trainer;
    if (!t.powerAvailable) return true; // ohne Leistungsdaten keine Auto-Pause möglich (wird angezeigt)
    if (t.powerAgeS() > this.cfg.powerStaleS) return false; // keine Daten = vermutlich Stillstand
    if (t.powerW > this.cfg.autoPauseWatts) this.lastPedalClock = this.clock;
    return this.clock - this.lastPedalClock < this.cfg.autoPauseDelayS;
  }

  togglePause() {
    if (!this.done) this.manualPause = !this.manualPause;
  }

  skip() {
    if (!this.done) this.session.skip();
  }

  async tick(dt) {
    if (this.done) return;
    this.clock += dt;
    const s = this.session;

    if (s.finished) return this.finish();

    const pedaling = this.isPedaling();
    const active = pedaling && !this.manualPause;
    if (active) {
      s.advance(dt);
      if (s.finished) return this.finish();
    }
    this.state = this.manualPause ? "paused" : active ? "riding" : "autopause";

    const target = s.targetWatts();
    this.gradeTarget = climbGrade(this.climb, s.totalElapsed);

    try {
      if (this.trainer.controlLost) throw new Error("Kontrolle über den KICKR verloren");
      if (!this.trainer.connected) throw new Error("Verbindung zum KICKR getrennt");
      if (target !== this.sentPower || this.clock - this.lastErgClock >= this.cfg.ergRefreshS) {
        await this.trainer.setPower(target);
        this.sentPower = target;
        this.lastErgClock = this.clock;
      }
      // Welle läuft nur in Fahrt weiter; nach Wiederverbindung (policy zurückgesetzt) sofort senden.
      if (this.climb.enabled && (active || this.policy.lastGrade === null)
          && this.policy.shouldSend(this.gradeTarget, this.clock)) {
        await this.trainer.setGrade(this.gradeTarget, target);
        this.policy.markSent(this.gradeTarget, this.clock);
        this.lastErgClock = this.clock; // setGrade sendet ERG mit
      }
      this.failedCycles = 0;
      this.message = "";
    } catch (err) {
      await this.recover(err);
    }
  }

  async recover(err) {
    if (this.done) return; // "Beenden" während eines laufenden Befehls: nicht neu verbinden
    this.failedCycles += 1;
    if (this.failedCycles > this.cfg.maxReconnectCycles) {
      this.state = "failed";
      this.message = `KICKR bricht wiederholt ab: ${errorText(err)}`;
      await this.safeClose();
      return;
    }
    this.state = "reconnecting";
    this.message = `${errorText(err)}. Training pausiert, verbinde neu …`;
    try {
      await this.trainer.reconnect();
      this.sentPower = null;
      this.policy.reset();
      this.message = "Wieder verbunden.";
    } catch (reconnectErr) {
      this.state = "failed";
      this.message = `Neu verbinden fehlgeschlagen: ${errorText(reconnectErr)}`;
      await this.safeClose();
    }
  }

  async finish() {
    this.state = "finished";
    this.message = "Training beendet.";
    await this.safeClose();
  }

  async stop() {
    if (this.done) return;
    this.state = "stopped";
    this.message = "Training beendet (abgebrochen).";
    await this.safeClose();
  }

  async safeClose() {
    try {
      this.climbReset = await this.trainer.close();
    } catch (err) {
      this.climbReset = false;
      this.message += ` CLIMB-Rückstellung fehlgeschlagen: ${errorText(err)}`;
    }
  }
}
