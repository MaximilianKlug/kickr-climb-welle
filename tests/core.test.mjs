import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RideController, Session, blockDuration, climbGrade, expandWorkout, fmtTime, newBlock, newPart, normalizeBlock,
  errorText, totalDuration, validateBlock, validateClimb,
} from "../core.js";
import { SimKickr, ergCommand, gradeCommand } from "../ble.js";

// Beispiel aus der Anfrage: 20 min 180 W, 10 min Rampe 180->220, 10x (30 s 400 W, 10 s 200 W), Erholung
const EXAMPLE = [
  { type: "steady", name: "Warmfahren", durationS: 1200, watts: 180 },
  { type: "ramp", name: "Steigern", durationS: 600, fromW: 180, toW: 220 },
  { type: "intervals", name: "Intervalle", repeats: 10, onS: 30, onW: 400, offS: 10, offW: 200 },
  { type: "steady", name: "Pause", durationS: 300, watts: 120 },
];

test("Beispieltraining wird korrekt aufgebaut", () => {
  const steps = expandWorkout(EXAMPLE);
  assert.equal(steps.length, 1 + 1 + 20 + 1);
  assert.equal(totalDuration(steps), 1200 + 600 + 400 + 300);
  assert.deepEqual([steps[2].durationS, steps[2].startW, steps[3].durationS, steps[3].startW], [30, 400, 10, 200]);
  assert.equal(steps[21].label, "Intervalle 10/10 Erholung");
});

test("Intervalle ohne Erholung erzeugen keine 0-s-Schritte", () => {
  const steps = expandWorkout([{ type: "intervals", name: "x", repeats: 3, onS: 60, onW: 300, offS: 0, offW: 100 }]);
  assert.equal(steps.length, 3);
});

test("ungültige Blöcke werden mit Blocknummer gemeldet", () => {
  assert.throws(() => expandWorkout([]), /keine Blöcke/);
  assert.throws(() => expandWorkout([{ type: "steady", name: "a", durationS: 0, watts: 100 }]), /Block 1/);
  assert.throws(() => expandWorkout([newBlock("steady"), { type: "steady", name: "b", durationS: 60, watts: 5000 }]), /Block 2/);
  assert.throws(() => expandWorkout([{ type: "intervals", name: "c", repeats: 2.5, onS: 1, onW: 1, offS: 1, offW: 1 }]), /ganze Zahl/);
  assert.throws(() => expandWorkout([{ type: "steady", name: "d", durationS: NaN, watts: 100 }]), /Dauer/);
});

test("CLIMB-Welle: von min nach max in der eingestellten Zeit und zurück", () => {
  const climb = { enabled: true, minPct: 1, maxPct: 7, minutesPerDirection: 5 };
  assert.equal(climbGrade(climb, 0), 1);
  assert.equal(climbGrade(climb, 150), 4);
  assert.equal(climbGrade(climb, 300), 7);
  assert.equal(climbGrade(climb, 450), 4);
  assert.equal(climbGrade(climb, 600), 1);
  assert.equal(climbGrade({ ...climb, enabled: false }, 300), 0);
  assert.equal(validateClimb({ minPct: 6, maxPct: 2, minutesPerDirection: 5 }).length, 1);
  assert.equal(validateClimb({ minPct: 0, maxPct: 25, minutesPerDirection: 5 }).length, 1);
});

test("Rampe und Intensität", () => {
  const s = new Session(expandWorkout([{ type: "ramp", name: "r", durationS: 600, fromW: 180, toW: 220 }]));
  s.advance(300);
  assert.equal(s.targetWatts(), 200);
  s.changeIntensity(+1);
  assert.equal(s.targetWatts(), 210);
});

test("fmtTime", () => {
  assert.equal(fmtTime(59.6), "1:00");
  assert.equal(fmtTime(3725), "1:02:05");
});

test("ERG- und Neigungsbefehle wie im Python-Skript", () => {
  assert.deepEqual([...new Uint8Array(ergCommand(180))], [0x05, 0xb4, 0x00]);
  assert.deepEqual([...new Uint8Array(gradeCommand(6))], [0x11, 0, 0, 0x58, 0x02, 0, 0]);
  assert.deepEqual([...new Uint8Array(gradeCommand(-5)).slice(3, 5)], [0x0c, 0xfe]);
});

async function ride(ctrl, trainer, seconds, { pedaling = true } = {}) {
  for (let i = 0; i < seconds && !ctrl.done; i++) {
    trainer.pedaling = pedaling;
    trainer.tickPower();
    await ctrl.tick(1);
  }
}

const CLIMB = { enabled: true, minPct: 0, maxPct: 6, minutesPerDirection: 5 };

test("Auto-Pause: ohne Treten bleibt die Zeit stehen, mit Treten geht es weiter", async () => {
  const trainer = new SimKickr();
  await trainer.connect();
  const ctrl = new RideController(expandWorkout([newBlock("steady")]), CLIMB, trainer);

  await ride(ctrl, trainer, 60);
  const before = ctrl.session.totalElapsed;
  assert.ok(before >= 57 && before <= 60, `nach 60 s Fahrt: ${before}`);

  await ride(ctrl, trainer, 300, { pedaling: false }); // Toilettenpause
  assert.equal(ctrl.state, "autopause");
  assert.ok(ctrl.session.totalElapsed - before <= 2, "Pause darf höchstens 2 s Verzögerung kosten");
  const paused = ctrl.session.totalElapsed;

  await ride(ctrl, trainer, 30);
  assert.equal(ctrl.state, "riding");
  assert.ok(ctrl.session.totalElapsed > paused + 25);
});

test("Welle bleibt in der Pause stehen und läuft danach weiter", async () => {
  const trainer = new SimKickr();
  await trainer.connect();
  const ctrl = new RideController(expandWorkout([newBlock("steady")]), CLIMB, trainer);
  await ride(ctrl, trainer, 151);
  const grade = trainer.gradeSent;
  assert.ok(grade > 2.5 && grade < 3.5, `nach 2,5 min etwa 3 %: ${grade}`);
  await ride(ctrl, trainer, 200, { pedaling: false });
  assert.equal(trainer.gradeSent, grade);
});

test("ganzes Training läuft durch, CLIMB am Ende auf 0", async () => {
  const trainer = new SimKickr();
  await trainer.connect();
  const steps = expandWorkout(EXAMPLE);
  const ctrl = new RideController(steps, CLIMB, trainer);
  await ride(ctrl, trainer, totalDuration(steps) + 20);
  assert.equal(ctrl.state, "finished");
  assert.equal(ctrl.climbReset, true);
  const ergs = trainer.commands.filter(([k]) => k === "erg").map(([, v]) => v);
  for (const w of [180, 200, 220, 400, 200, 120]) assert.ok(ergs.includes(w), `ERG ${w} fehlt`);
  assert.deepEqual(trainer.commands.at(-1), ["grade", 0]);
  const grades = trainer.commands.filter(([k]) => k === "grade").map(([, v]) => v);
  assert.ok(Math.max(...grades) >= 5.9 && Math.max(...grades) <= 6);
});

test("letzten Schritt in der Pause überspringen sendet kein 0 W", async () => {
  const trainer = new SimKickr();
  await trainer.connect();
  const ctrl = new RideController(expandWorkout([newBlock("recovery")]), CLIMB, trainer);
  await ride(ctrl, trainer, 5);
  ctrl.togglePause();
  ctrl.skip();
  await ctrl.tick(1);
  assert.equal(ctrl.state, "finished");
  assert.ok(!trainer.commands.some(([k, v]) => k === "erg" && v === 0));
});

class FlakyKickr extends SimKickr {
  constructor(failAt) {
    super();
    this.failAt = failAt;
    this.ergCalls = 0;
    this.reconnects = 0;
  }
  async setPower(w) {
    this.ergCalls += 1;
    if (this.failAt.includes(this.ergCalls)) throw new Error("simulierter Abbruch");
    await super.setPower(w);
  }
  async reconnect() {
    this.reconnects += 1;
    await super.reconnect();
  }
}

test("Verbindungsabbruch: neu verbinden und weiterfahren", async () => {
  const trainer = new FlakyKickr([3]);
  await trainer.connect();
  const steps = expandWorkout([{ type: "steady", name: "a", durationS: 30, watts: 150 },
    { type: "steady", name: "b", durationS: 30, watts: 250 }]);
  const ctrl = new RideController(steps, CLIMB, trainer);
  await ride(ctrl, trainer, 80);
  assert.equal(ctrl.state, "finished");
  assert.equal(trainer.reconnects, 1);
});

test("dauerhafte Fehler beenden die Fahrt mit Meldung", async () => {
  const trainer = new FlakyKickr(Array.from({ length: 100 }, (_, i) => i + 1));
  await trainer.connect();
  const ctrl = new RideController(expandWorkout([newBlock("steady")]), CLIMB, trainer);
  await ride(ctrl, trainer, 20);
  assert.equal(ctrl.state, "failed");
  assert.match(ctrl.message, /wiederholt/);
});

// ---------------------------------------------------------------- Intervalle mit beliebig vielen Teilen

test("Intervall mit 4 Teilen und 5 Wiederholungen (100/200/300 W, 50 W Pause)", () => {
  const block = {
    type: "intervals", name: "Treppe", repeats: 5,
    parts: [newPart(60, 100, "Stufe 1"), newPart(60, 200, "Stufe 2"), newPart(60, 300, "Stufe 3"), newPart(60, 50, "Pause")],
  };
  const steps = expandWorkout([block]);
  assert.equal(steps.length, 20);
  assert.deepEqual(steps.slice(0, 5).map((s) => s.startW), [100, 200, 300, 50, 100]);
  assert.equal(steps[19].label, "Treppe 5/5 Pause");
  assert.equal(blockDuration(block), 5 * 4 * 60);
});

test("Teile ohne Namen werden durchnummeriert", () => {
  const steps = expandWorkout([{ type: "intervals", name: "X", repeats: 1, parts: [newPart(10, 100), newPart(10, 200)] }]);
  assert.deepEqual(steps.map((s) => s.label), ["X 1/1 Teil 1/2", "X 1/1 Teil 2/2"]);
});

test("Altes Intervallformat wird umgewandelt", () => {
  const b = normalizeBlock({ type: "intervals", name: "alt", repeats: 2, onS: 30, onW: 400, offS: 10, offW: 200 });
  assert.deepEqual(b.parts, [newPart(30, 400, "Belastung"), newPart(10, 200, "Erholung")]);
  assert.equal("onS" in b, false);
  assert.equal(normalizeBlock(b), b);
});

test("Ungültige Teile werden gemeldet", () => {
  assert.match(validateBlock({ type: "intervals", name: "a", repeats: 2, parts: [] })[0], /1 bis/);
  assert.match(validateBlock({ type: "intervals", name: "a", repeats: 2, parts: [newPart(60, 100), newPart(0, 100)] })[0], /Teil 2/);
});

test("Kopierter Block ist unabhängig vom Original (Set nach Pause wiederholen)", () => {
  const set = newBlock("intervals");
  const copy = structuredClone(set);
  copy.parts[0].watts = 999;
  const steps = expandWorkout([set, newBlock("recovery"), structuredClone(set)]);
  assert.equal(steps[0].startW, 400);
  assert.equal(steps.at(-2).startW, 400);
  assert.equal(totalDuration(steps), 2 * blockDuration(set) + 300);
});

test("errorText liefert nie 'undefined'", () => {
  assert.equal(errorText(new Error("kaputt")), "kaputt");
  assert.equal(errorText(Object.assign(new Error(""), { name: "NetworkError" })), "NetworkError");
  assert.equal(errorText("Bluefy: abgebrochen"), "Bluefy: abgebrochen");
  assert.equal(errorText(undefined), "unbekannter Fehler");
  assert.equal(errorText({ code: 8 }), '{"code":8}');
  assert.match(errorText({}), /unbekannter Fehler/);
  assert.doesNotMatch(errorText({ message: undefined, name: "Error" }), /undefined/);
});
