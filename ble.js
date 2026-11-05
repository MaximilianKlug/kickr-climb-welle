// Web-Bluetooth-Anbindung des KICKR (FTMS) und Simulator. Ablauf wie in kickr/trainer.py:
// Kontrolle anfordern (0x00), Neigung (0x11), 300 ms warten, ERG (0x05) sofort neu senden.

const FTMS_SERVICE = 0x1826;
const FTMS_CONTROL = 0x2ad9;
const FTMS_STATUS = 0x2ada;
const CPS_SERVICE = 0x1818;
const CPS_MEASUREMENT = 0x2a63;

const OP_REQUEST_CONTROL = 0x00;
const OP_SET_TARGET_POWER = 0x05;
const OP_SET_SIMULATION = 0x11;
const OP_RESPONSE = 0x80;
const RESULT_SUCCESS = 0x01;
const RESULT_NOT_PERMITTED = 0x05;
const STATUS_CONTROL_LOST = 0xff;

const GRADE_ERG_DELAY_MS = 300;
const SETTLE_MS = 2000;
const WRITE_TIMEOUT_MS = 5000;
const CONTROL_CONFIRM_MS = 2000;
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 4000;

const OP_NAMES = { [OP_REQUEST_CONTROL]: "Kontrolle", [OP_SET_TARGET_POWER]: "ERG", [OP_SET_SIMULATION]: "Neigung" };
const RESULT_NAMES = { 2: "nicht unterstützt", 3: "ungültiger Wert", 4: "fehlgeschlagen", 5: "Kontrolle nicht erlaubt" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: keine Antwort nach ${ms / 1000} s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export function ergCommand(watts) {
  const buf = new DataView(new ArrayBuffer(3));
  buf.setUint8(0, OP_SET_TARGET_POWER);
  buf.setInt16(1, Math.round(watts), true);
  return buf.buffer;
}

export function gradeCommand(grade) {
  // Wind 0, Neigung in 0,01 %, Rollwiderstand 0, Luftwiderstand 0 (wie kicker_workout.py)
  const buf = new DataView(new ArrayBuffer(7));
  buf.setUint8(0, OP_SET_SIMULATION);
  buf.setInt16(1, 0, true);
  buf.setInt16(3, Math.round(grade * 100), true);
  buf.setUint8(5, 0);
  buf.setUint8(6, 0);
  return buf.buffer;
}

export function describeRejection(opcode, result) {
  const op = OP_NAMES[opcode] ?? `0x${opcode.toString(16)}`;
  return `KICKR lehnt '${op}' ab: ${RESULT_NAMES[result] ?? `Code ${result}`}`;
}

/** Wahoo-Zubehör, das selbst kein Trainer ist (CLIMB hängt am Trainer, HEADWIND ist ein Lüfter). */
export function isAccessoryName(name) {
  return /CLIMB|HEADWIND/i.test(name ?? "");
}

export function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function bluetoothSupport() {
  if (!("bluetooth" in navigator)) {
    return isIos()
      ? "Auf iPad und iPhone kann kein normaler Browser Bluetooth, auch Chrome und Edge nicht (Apple-Vorgabe). "
        + "Lade die kostenlose App „Bluefy – Web BLE Browser“ aus dem App Store und öffne diese Seite darin."
      : "Dieser Browser kann kein Bluetooth. Bitte Chrome oder Edge verwenden.";
  }
  if (!window.isSecureContext) return "Bluetooth braucht eine https-Adresse (oder localhost).";
  return null;
}

export class KickrBle {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent; // ({type: 'status'|'warning'|'power'|'disconnected', text})
    this.device = null;
    this.control = null;
    this.powerAvailable = false;
    this.powerW = 0;
    this.powerTime = 0;
    this.controlLost = false;
    this.rejections = 0;
    this.gradeSent = null;
    this.responses = new Map();
    this.queue = Promise.resolve();
    this.closing = false;
    // Feste Handler: addEventListener ignoriert dieselbe Funktion beim Neuverbinden, sonst doppelte Auswertung.
    this.handleControl = (e) => this.onControlResponse(e.target.value);
    this.handleStatus = (e) => {
      if (e.target.value.getUint8(0) === STATUS_CONTROL_LOST) {
        this.controlLost = true;
        this.onEvent({ type: "warning", text: "KICKR meldet: Kontrolle verloren (andere App?)" });
      }
    };
    this.handlePower = (e) => {
      const v = e.target.value;
      if (v.byteLength >= 4) {
        this.powerW = v.getInt16(2, true);
        this.powerTime = performance.now();
        this.onEvent({ type: "power", watts: this.powerW });
      }
    };
  }

  get name() {
    return this.device?.name || "KICKR";
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected && this.control);
  }

  powerAgeS() {
    return (performance.now() - this.powerTime) / 1000;
  }

  /** Muss aus einem Klick heraus aufgerufen werden (Browser-Vorgabe). */
  async select() {
    // Jeder Trainer mit Bluetooth FTMS oder Wahoo-Namen ("Wahoo KICKR 1A2B", "KICKR CORE …").
    // exclusionFilters blendet CLIMB ("KICKR CLIMB 3C4D") und HEADWIND aus, Browser ohne diese Option ignorieren sie.
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }, { namePrefix: "Wahoo KICKR" }, { namePrefix: "KICKR" }],
      exclusionFilters: [{ namePrefix: "KICKR CLIMB" }, { namePrefix: "KICKR HEADWIND" }],
      optionalServices: [FTMS_SERVICE, CPS_SERVICE],
    });
    if (isAccessoryName(device.name)) {
      throw new Error(`„${device.name}“ ist kein Trainer. Bitte den KICKR selbst auswählen, der CLIMB läuft über ihn.`);
    }
    this.device = device;
    this.device.addEventListener("gattserverdisconnected", () => {
      this.control = null;
      if (!this.closing) this.onEvent({ type: "disconnected", text: "Verbindung zum KICKR getrennt" });
    });
  }

  async connect() {
    if (!this.device) throw new Error("Kein KICKR ausgewählt");
    this.controlLost = false;
    this.gradeSent = null;
    this.powerW = 0;
    this.onEvent({ type: "status", text: `Verbinde mit ${this.name} …` });
    const server = await withTimeout(this.device.gatt.connect(), 20000, "Verbinden");
    await sleep(SETTLE_MS);

    let ftms;
    try {
      ftms = await server.getPrimaryService(FTMS_SERVICE);
    } catch {
      throw new Error(`${this.name} bietet kein Bluetooth FTMS. Firmware in der Wahoo-App aktualisieren.`);
    }
    const control = await ftms.getCharacteristic(FTMS_CONTROL);
    await control.startNotifications();
    control.addEventListener("characteristicvaluechanged", this.handleControl);
    this.control = control;

    try {
      const status = await ftms.getCharacteristic(FTMS_STATUS);
      await status.startNotifications();
      status.addEventListener("characteristicvaluechanged", this.handleStatus);
    } catch (err) {
      this.onEvent({ type: "warning", text: `Statusmeldungen nicht verfügbar (${err.message})` });
    }

    await this.requestControl();
    await this.write(gradeCommand(0));
    this.gradeSent = 0;
    await sleep(SETTLE_MS);

    this.powerAvailable = false;
    try {
      const cps = await server.getPrimaryService(CPS_SERVICE);
      const power = await cps.getCharacteristic(CPS_MEASUREMENT);
      power.addEventListener("characteristicvaluechanged", this.handlePower);
      await power.startNotifications();
      this.powerAvailable = true;
      this.powerTime = performance.now();
    } catch (err) {
      this.onEvent({ type: "warning", text: `Keine Leistungsdaten, Auto-Pause aus (${err.message})` });
    }
    this.onEvent({ type: "status", text: `Verbunden mit ${this.name}` });
  }

  onControlResponse(view) {
    if (view.byteLength < 3 || view.getUint8(0) !== OP_RESPONSE) return;
    const opcode = view.getUint8(1);
    const result = view.getUint8(2);
    this.responses.set(opcode, result);
    if (result === RESULT_SUCCESS) return;
    this.rejections += 1;
    if (result === RESULT_NOT_PERMITTED) this.controlLost = true;
    this.onEvent({ type: "warning", text: describeRejection(opcode, result) });
  }

  async requestControl() {
    this.responses.delete(OP_REQUEST_CONTROL);
    await this.write(new Uint8Array([OP_REQUEST_CONTROL]).buffer);
    const deadline = performance.now() + CONTROL_CONFIRM_MS;
    while (!this.responses.has(OP_REQUEST_CONTROL) && performance.now() < deadline) await sleep(100);
    const result = this.responses.get(OP_REQUEST_CONTROL);
    if (result === undefined) {
      this.onEvent({ type: "warning", text: "KICKR hat die Kontrollanfrage nicht bestätigt" });
    } else if (result !== RESULT_SUCCESS) {
      throw new Error(`${describeRejection(OP_REQUEST_CONTROL, result)}. Zwift, Wahoo-App oder Edge-Trainerkopplung trennen.`);
    }
  }

  /** Schreibbefehle nacheinander, Web Bluetooth erlaubt keine parallelen GATT-Operationen. */
  write(buffer) {
    const run = async () => {
      if (!this.connected) throw new Error("KICKR nicht verbunden");
      const c = this.control;
      const op = c.writeValueWithResponse ? c.writeValueWithResponse(buffer) : c.writeValue(buffer);
      await withTimeout(op, WRITE_TIMEOUT_MS, "Befehl an KICKR");
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async setPower(watts) {
    await this.write(ergCommand(watts));
  }

  async setGrade(grade, watts) {
    await this.write(gradeCommand(grade));
    this.gradeSent = grade;
    await sleep(GRADE_ERG_DELAY_MS);
    await this.write(ergCommand(watts));
  }

  async reconnect() {
    let lastError = null;
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
      this.onEvent({ type: "status", text: `Neu verbinden, Versuch ${attempt}/${RECONNECT_ATTEMPTS} …` });
      try {
        if (this.device?.gatt?.connected) this.device.gatt.disconnect();
        await this.connect();
        return;
      } catch (err) {
        lastError = err;
        if (attempt < RECONNECT_ATTEMPTS) await sleep(RECONNECT_DELAY_MS);
      }
    }
    throw new Error(`nach ${RECONNECT_ATTEMPTS} Versuchen nicht erreichbar (${lastError?.message})`);
  }

  /** CLIMB auf 0 % und trennen. true = Rückstellung angenommen. */
  async close() {
    let ok = false;
    this.closing = true;
    try {
      if (this.connected) {
        this.responses.delete(OP_SET_SIMULATION);
        await this.write(gradeCommand(0));
        await sleep(500); // eine Ablehnung käme in dieser Zeit
        ok = (this.responses.get(OP_SET_SIMULATION) ?? RESULT_SUCCESS) === RESULT_SUCCESS;
        if (ok) this.gradeSent = 0;
      }
    } finally {
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
      this.control = null;
      this.closing = false;
    }
    return ok;
  }
}

/** Ersatz ohne Bluetooth. pedaling steuert, ob simuliert getreten wird. */
export class SimKickr {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
    this.name = "Simulator";
    this.powerAvailable = true;
    this.powerW = 0;
    this.controlLost = false;
    this.rejections = 0;
    this.gradeSent = null;
    this.pedaling = true;
    this.target = 0;
    this._connected = false;
    this.commands = [];
  }

  get connected() {
    return this._connected;
  }

  powerAgeS() {
    return 0;
  }

  async select() {}

  async connect() {
    this._connected = true;
    this.gradeSent = 0;
    this.onEvent({ type: "status", text: "Verbunden mit Simulator" });
  }

  tickPower() {
    this.powerW = this.pedaling ? this.target : 0;
    this.onEvent({ type: "power", watts: this.powerW });
  }

  async setPower(watts) {
    this.target = watts;
    this.commands.push(["erg", watts]);
  }

  async setGrade(grade, watts) {
    this.gradeSent = grade;
    this.commands.push(["grade", grade]);
    await this.setPower(watts);
  }

  async reconnect() {
    await this.connect();
  }

  async close() {
    const was = this._connected;
    if (was) {
      this.gradeSent = 0;
      this.commands.push(["grade", 0]);
    }
    this._connected = false;
    return was;
  }
}
