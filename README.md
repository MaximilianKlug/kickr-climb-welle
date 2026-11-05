# KICKR CLIMB-Welle

Browser-App für Wahoo KICKR + KICKR CLIMB: Training (Konstant, Rampe, Intervalle) zusammenklicken,
Trainer per Bluetooth verbinden, losfahren. Der Trainer fährt die Leistung im ERG-Modus, der CLIMB
fährt währenddessen langsam zwischen zwei Neigungen hoch und runter, damit sich die Sitzposition ändert.

**Öffnen:** https://maximilianklug.github.io/kickr-climb-welle/

## Voraussetzungen

- Wahoo-Trainer mit Bluetooth FTMS (KICKR, KICKR CORE, KICKR MOVE, KICKR SNAP, aktuelle Firmware über die Wahoo-App).
- KICKR CLIMB einmal in der Wahoo-App mit dem Trainer koppeln.
- Chrome oder Edge auf Android, Windows oder Mac. iPhone/iPad: App „Bluefy“ (Safari kann kein Web Bluetooth).
- Zwift, Wahoo-App usw. schließen. Uhr/Radcomputer den Trainer nur als Leistungsmesser koppeln, nicht als Smart Trainer.

## Funktionen

- Intervalle mit beliebig vielen Teilen pro Durchgang (z. B. 1 min 100/200/300 W, 1 min 50 W) und Wiederholungen.
- Blöcke kopieren und später wieder einfügen (z. B. dasselbe Set nach einer Pause).
- Auto-Pause: Hörst du auf zu treten (unter 15 W), stehen Trainingszeit und CLIMB-Welle. Weitertreten = weiter.
- Intensität ±5 %, Block überspringen, Pause, Beenden (CLIMB fährt auf 0 %).
- Trainings werden nur im Browser des Geräts gespeichert. Die Seite verschickt keine Daten.
- Testen ohne Trainer: Häkchen „Ohne KICKR testen“.

## Hinweis

Privates Projekt, nicht von Wahoo. Nutzung auf eigene Gefahr.

Tests: `node --test tests/core.test.mjs`
