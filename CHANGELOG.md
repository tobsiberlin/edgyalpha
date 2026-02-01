# Changelog

Alle wichtigen Änderungen an diesem Projekt werden hier dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und das Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

---

## [1.6.0] - 2026-02-01

### Hinzugefügt
- **Trading-Feedback**
  - Trade-Buttons zeigen klare Fehlermeldungen
  - Prüfung: Trading aktiviert? Wallet konfiguriert? Genug Balance?
  - Detaillierte Log-Ausgaben bei Trade-Versuchen

### Geändert
- `/api/trade` prüft jetzt alle Voraussetzungen
- Frontend zeigt Trading-Feedback in der Konsole
- Version auf 1.6.0 aktualisiert

---

## [1.5.0] - 2026-02-01

### Hinzugefügt
- **Telegram Commands**
  - `/scan` - Starte Markt-Scan direkt per Command
  - `/status` - System-Status anzeigen
  - `/wallet` - Echte Wallet-Balance
  - `/polls` - Aktuelle Wahlumfragen
  - `/news` - Deutsche News
  - `/signals` - Aktuelle Alpha-Signale
- Telegram Wallet zeigt echte Polygon-Balance

### Geändert
- Telegram Bot nutzt jetzt tradingClient für echte Balance
- Version auf 1.5.0 aktualisiert

---

## [1.4.0] - 2026-02-01

### Hinzugefügt
- **Wallet-Integration**
  - `/api/wallet` Endpoint zeigt echte USDC/MATIC Balance von Polygon
  - Wallet-Anzeige im Dashboard (Balance + Adresse)
  - Klare "Nicht konfiguriert" Meldung wenn kein Private Key
- Wallet-Status in `/api/config` Response

### Geändert
- Bankroll-Anzeige ersetzt durch echte Wallet-Balance
- Dashboard zeigt Wallet-Adresse (gekürzt)

---

## [1.3.0] - 2026-02-01

### Hinzugefügt
- **Almanien-Modul komplett aktiviert**
  - Dawum-Umfragen zeigen echte Werte (CDU/CSU, AfD, SPD, Grüne, BSW, Linke, FDP)
  - RSS-News-Feed mit deutschen Quellen (Tagesschau, Spiegel, Zeit, FAZ, Handelsblatt)
  - Bundestag-Feed mit Hinweis auf API-Key-Registrierung
- BSW (Bündnis Sahra Wagenknecht) als neue Partei in Umfragen
- Linke-Partei mit korrekter Farbe
- Parteifarben im Matrix-Style mit Glow-Effekten

### Geändert
- Umfragen-Anzeige zeigt Institut und Datum
- "GRÜNE" → "Grüne" (korrekte API-Bezeichnung)
- Mehr Almanien-Humor in Fehlermeldungen

### Behoben
- Bundestag-Feed zeigte endlos "Lade Gesetzgebungsdaten..." - jetzt klare Meldung
- News-Feed zeigte "Keine News verfügbar" ohne Humor - jetzt mit Almanien-Style

---

## [1.2.0] - 2026-02-01

### Hinzugefügt
- **Session-basierte Authentifizierung** statt nerviger Basic Auth
- Neue Login-Seite (`/login`) mit Matrix-Style Design
- Logout-Funktion (`/logout`)
- 24h Session-Cookies (einmal einloggen reicht)

### Geändert
- Nginx Basic Auth entfernt (war nervig bei Navigation)
- Alle API-Calls nutzen jetzt Session-Cookies

### Behoben
- Kein ständiges Auth-Popup mehr beim Navigieren

---

## [1.1.1] - 2026-02-01

### Geändert
- Boot-Animation verlängert auf ~5 Sekunden
- ASCII-Logo mit Glow-Effekt animiert
- Blinkender Cursor während Boot-Sequenz
- Mehr Boot-Messages für authentisches Terminal-Feeling

### Behoben
- HTTP/2 deaktiviert (verursachte SSL-Fehler bei manchen Clients)

---

## [1.1.0] - 2026-02-01

### Hinzugefügt
- Ausführliches README mit ASCII-Art, Badges und Dokumentation
- CHANGELOG-Datei für Versionsverfolgung
- Deutsche Übersetzung der Web-Oberfläche ("Almanien-Modul")
- Krassere Telegram-Bot Sprache mit mehr Charakter

### Geändert
- Polymarket API Client: JSON-Strings (`outcomePrices`, `outcomes`, `clobTokenIds`) werden jetzt korrekt geparst
- Kategorie-Erkennung basiert jetzt auf der Frage statt auf nicht-existierendem `category`-Feld
- Standard `MIN_VOLUME_USD` von 100.000 auf 10.000 reduziert (mehr Märkte)
- Erweiterte Kategorie-Keywords für Politik (Trump, Biden, Merz, Scholz, etc.)
- Status-Dots im Header: Perplexity/Claude durch Almanien/WebSocket ersetzt
- Alle UI-Texte auf Deutsch umgestellt
- ASCII-Logo auf "EDGY ALPHA" geändert
- Telegram-Bot: Krassere Sprache, mehr Almanien-Stil

### Behoben
- Polymarket API gibt jetzt echte Marktdaten zurück (war vorher 0 Märkte)
- Kategorie-Filter filtert nicht mehr alle Märkte raus
- Bankroll-Anzeige zeigt jetzt Konfigurationswert statt hardcoded $1,000

---

## [1.0.1] - 2026-02-01

### Behoben
- SSH-Deployment via GitHub Actions
- SSH-Key Konfiguration auf VPS

---

## [1.0.0] - 2026-02-01

### Hinzugefügt
- Initiales Release
- Polymarket Scanner mit Gamma API Integration
- Almanien-Modul (Dawum, Bundestag DIP, RSS-Feeds)
- Terminal-Style Web-Dashboard (Matrix-Aesthetik)
- Telegram Bot mit Inline-Buttons
- Alpha-Scoring System
- Kelly-Kriterium für Position-Sizing
- GitHub Actions CI/CD Pipeline
- PM2 Prozessmanagement

---

## Versionsschema

- **MAJOR**: Inkompatible API-Änderungen
- **MINOR**: Neue Features, abwärtskompatibel
- **PATCH**: Bugfixes, abwärtskompatibel
