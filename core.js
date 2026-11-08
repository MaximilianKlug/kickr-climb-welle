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
  gradeIntervalS: 30,     // jeder Neigungsbefehl schaltet den KICKR kurz aus dem ERG-Modus, daher selten senden
  intensityStepPct: 5,
  maxReconnectCycles: 3,
  maxSoftRetries: 2,      // Befehl fehlgeschlagen, Verbindung steht noch: so oft im nächsten Takt neu senden, bevor neu verbunden wird
  powerDeviationW: 50,    // Protokoll: Istleistung weicht mindestens so weit vom Ziel ab ...
  powerDeviationPct: 25,  // ... bzw. so viel Prozent des Ziels (der größere Wert zählt) ...
  powerDeviationS: 3,     // ... und das so lange am Stück ...
  powerDeviationGraceS: 10, // ... nicht in den ersten Sekunden nach einem Leistungssprung oder Weitertreten
  powerGapLogS: 3,        // fehlende Leistungsdaten ab 3 s ins Protokoll (Hinweis auf Bluetooth-Aussetzer)
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
    this.events = []; // Protokoll für Anzeige und Fehlersuche: { at: Trainingszeit s, text }
    this.disconnects = 0;
    this.retries = 0;        // wiederholte Befehle ohne Neuverbindung (gesamt)
    this.softFailures = 0;   // aufeinanderfolgende, setzt sich bei Erfolg zurück
    this.powerGap = false;
    this.ergConfirmDue = false; // ERG im Takt nach einem Neigungsbefehl noch einmal senden
    this.deviation = null;      // laufende Abweichung Ist/Ziel
    this.graceUntil = cfg.powerDeviationGraceS;
    this.lastTarget = null;
    this.autoPaused = false;  // nur nach einer protokollierten Auto-Pause "Weiter" protokollieren
  }

  log(text) {
    this.events.push({ at: this.session.totalElapsed, text });
    if (this.events.length > 200) this.events.shift();
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
    const previous = this.state;
    this.state = this.manualPause ? "paused" : active ? "riding" : "autopause";
    this.logTransitions(previous);

    const target = s.targetWatts();
    this.gradeTarget = climbGrade(this.climb, s.totalElapsed);
    this.watchDeviation(target, previous);

    try {
      if (this.trainer.controlLost) throw new Error("Kontrolle über den KICKR verloren");
      if (!this.trainer.connected) throw new Error("Verbindung zum KICKR getrennt");
      if (target !== this.sentPower || this.ergConfirmDue || this.clock - this.lastErgClock >= this.cfg.ergRefreshS) {
        await this.trainer.setPower(target);
        this.sentPower = target;
        this.lastErgClock = this.clock;
        this.ergConfirmDue = false;
      }
      // Welle läuft nur in Fahrt weiter; nach Wiederverbindung (policy zurückgesetzt) sofort senden.
      if (this.climb.enabled && (active || this.policy.lastGrade === null)
          && this.policy.shouldSend(this.gradeTarget, this.clock)) {
        await this.trainer.setGrade(this.gradeTarget, target);
        this.policy.markSent(this.gradeTarget, this.clock);
        this.lastErgClock = this.clock; // setGrade sendet ERG mit
        // Geht dieses ERG unter, bliebe der KICKR bis zur nächsten Auffrischung im Neigungsmodus.
        this.ergConfirmDue = true;
      }
      this.failedCycles = 0;
      this.softFailures = 0;
      this.message = "";
    } catch (err) {
      // Steht die Verbindung noch, nicht gleich trennen und neu verbinden (das dauert Sekunden und der
      // Widerstand fehlt solange), sondern im nächsten Takt erneut senden.
      const t = this.trainer;
      if (t.connected && !t.controlLost && this.softFailures < this.cfg.maxSoftRetries) {
        this.softFailures += 1;
        this.retries += 1;
        this.sentPower = null; // Leistung im nächsten Takt neu senden; eine nicht gesendete Neigung folgt ohnehin
        this.log(`Befehl nicht angekommen, Verbindung steht, sende erneut (${errorText(err)})`);
        return;
      }
      await this.recover(err);
    }
  }

  /** Protokoll: Istleistung passt länger nicht zum Ziel. Zeigt Vorfälle, die keine Verbindungsfehler sind. */
  watchDeviation(target, previous) {
    const t = this.trainer;
    const cfg = this.cfg;
    if (this.lastTarget !== null && Math.abs(target - this.lastTarget) >= 20) this.graceUntil = this.clock + cfg.powerDeviationGraceS;
    if (previous !== "riding") this.graceUntil = this.clock + cfg.powerDeviationGraceS;
    this.lastTarget = target;
    const usable = this.state === "riding" && t.powerAvailable && t.connected && t.powerAgeS() < cfg.powerGapLogS
      && this.clock >= this.graceUntil;
    const dev = this.deviation;
    const limit = Math.max(cfg.powerDeviationW, (target * cfg.powerDeviationPct) / 100);
    if (!usable || Math.abs(t.powerW - target) < limit) {
      if (dev?.logged) this.log(`Leistung wieder am Ziel nach ${Math.round(this.clock - dev.since)} s (Extremwert ${dev.extreme} W)`);
      this.deviation = null;
      return;
    }
    const current = dev ?? { since: this.clock, logged: false, extreme: t.powerW };
    if (Math.abs(t.powerW - target) > Math.abs(current.extreme - target)) current.extreme = t.powerW;
    if (!current.logged && this.clock - current.since >= cfg.powerDeviationS) {
      current.logged = true;
      const age = this.policy.lastGrade === null ? "" : `, letzter Neigungsbefehl vor ${Math.round(this.clock - this.policy.lastTime)} s`;
      this.log(`Leistung weicht ab: Ziel ${target} W, Ist ${t.powerW} W, Neigung ${this.gradeTarget.toFixed(1)} %${age}`);
    }
    this.deviation = current;
  }

  /** Protokolleinträge für Auto-Pause und fehlende Leistungsdaten (Fehlersuche nach dem Training). */
  logTransitions(previous) {
    const t = this.trainer;
    if (previous === "riding" && this.state === "autopause") {
      const noData = t.powerAvailable && t.powerAgeS() > this.cfg.powerStaleS;
      this.log(noData ? "Auto-Pause: keine Leistungsdaten vom KICKR" : `Auto-Pause: unter ${this.cfg.autoPauseWatts} W`);
      this.autoPaused = true;
    } else if (this.autoPaused && this.state === "riding") {
      this.autoPaused = false;
      this.log("Weiter nach Auto-Pause");
    }
    if (!t.powerAvailable || !t.connected) return;
    const age = t.powerAgeS();
    if (!this.powerGap && this.state === "riding" && age >= this.cfg.powerGapLogS) {
      this.powerGap = true;
      this.log(`Leistungsdaten fehlen seit ${Math.round(age)} s`);
    } else if (this.powerGap && age < 1.5) {
      this.powerGap = false;
      this.log("Leistungsdaten wieder da");
    }
  }

  async recover(err) {
    if (this.done) return; // "Beenden" während eines laufenden Befehls: nicht neu verbinden
    this.failedCycles += 1;
    this.disconnects += 1;
    const lostAt = Date.now(); // echte Zeit: clock steht während des Wiederverbindens
    this.log(`Verbindung unterbrochen: ${errorText(err)}`);
    if (this.failedCycles > this.cfg.maxReconnectCycles) {
      this.state = "failed";
      this.message = `KICKR bricht wiederholt ab: ${errorText(err)}`;
      await this.safeClose();
      return;
    }
    this.state = "reconnecting";
    this.softFailures = 0;
    // Nur die Kontrolle verloren (z. B. andere App), Verbindung steht: Kontrolle neu anfordern statt neu verbinden.
    if (this.trainer.connected && this.trainer.controlLost && this.trainer.regainControl) {
      try {
        await this.trainer.regainControl();
        if (!this.trainer.controlLost) {
          this.sentPower = null;
          this.policy.reset();
          this.log("Kontrolle zurückgeholt, ohne neu zu verbinden");
          return;
        }
      } catch (regainErr) {
        this.log(`Kontrolle zurückholen fehlgeschlagen: ${errorText(regainErr)}`);
      }
    }
    this.message = `${errorText(err)}. Training pausiert, verbinde neu …`;
    try {
      await this.trainer.reconnect();
      this.sentPower = null;
      this.policy.reset();
      this.message = "Wieder verbunden.";
      this.log(`Wieder verbunden nach ${Math.max(1, Math.round((Date.now() - lostAt) / 1000))} s`);
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
