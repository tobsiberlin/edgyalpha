# Lessons Learned - Alpha Engines V2

> Aktualisiert nach jeder Korrektur vom User

---

## Workflow-Regeln (IMMER befolgen)

### Sprache
- **Immer auf Deutsch antworten**

### Commits & Versionskontrolle
- Nach JEDER größeren Änderung committen
- **NIE automatisch pushen** – nur anbieten
- Vor jedem Commit:
  1. `CHANGELOG.md` aktualisieren
  2. `README.md` prüfen und ggf. ergänzen
  3. Dann erst committen

### Planungsmodus
- Bei JEDER nicht-trivialen Aufgabe (3+ Schritte) in Planungsmodus
- Wenn etwas schiefgeht: STOPPEN und neu planen
- Detaillierte Spezifikationen vorab schreiben

### Subagents
- Großzügig einsetzen für sauberes Hauptkontextfenster
- Recherche, Exploration, parallele Analysen auslagern
- Eine Aufgabe pro Subagent

### Verifikation
- Niemals "Done" ohne Beweis dass es funktioniert
- Fragen: "Würde ein Senior-Entwickler das absegnen?"
- Tests, Logs, Type-Check prüfen

---

## Architektur-Prinzipien

### 1. Mehr Signale ≠ mehr Profit
- Optimiere für **weniger, bessere, kalibrierte** Signale
- Harte Risk-Gates sind Pflicht
- Jedes Feature muss geloggt, versioniert, ausgewertet werden

### 2. Keine Heuristik-Suppe
- Strikte Trennung: TIME_DELAY vs MISPRICING
- Keine Feature-Vermischung ohne expliziten Meta-Combiner
- Feature-Versionierung in jedem Signal

### 3. Keine "fake live" Execution
- `paper` = Default, nur Logging
- `shadow` = Quotes holen, simulieren
- `live` = nur mit echten Credentials
- Harte Verweigerung wenn Credentials fehlen

---

## Maschinelles Lernen (ML-Regeln)

### Wo ML einsetzen (gezielt, nicht überall)
1. **Meta-Combiner**: Lernt Gewichte/Trade-Probability aus Outcomes
   - Online Logistic Regression oder Bayesian Weights
   - Walk-Forward-Backtests für Evaluation
2. **Optional Matching**: News→Market Clustering
   - LLM/Embeddings nur gecached + Fallback
   - Kein harter Dependency

### Wo KEIN ML
- **P_true Schätzung**: Bleibt transparent (Trends/Priors/Uncertainty)
- Keine Blackbox die direkt Wahrscheinlichkeiten vorhersagt

### ML-Anforderungen
- Trainingsdaten/Features in SQLite speichern
- Feature-Versionierung via featureRegistry
- Jeder ML-Schritt muss erklärbar sein
- Walk-Forward-Backtests (kein Overfitting)
- Top-Features müssen in Rationale erscheinen

---

## Technische Patterns

### SQLite
- `better-sqlite3` für synchrone, schnelle API
- Unique-Constraints für Idempotenz
- Migrations müssen wiederholbar sein

### RSS/External APIs
- Per-Request Timeout (8s max)
- `Promise.allSettled` statt `Promise.all`
- Soft-Fails mit Health-Tracking
- Kuratierte Feed-Listen (WORKING vs EXPERIMENTAL)

### Backtesting
- Echte Daten (poly_data) statt Simulation
- Kein Lookahead-Bias
- Walk-Forward Validation
- Slippage aus echten Trades kalibrieren

---

## Fehler-Vermeidung

### Stabilitaetsprobleme (2026-02-02)

**Problem:** User frustriert weil "alles kaputt" - WebSocket getrennt, Seiten laden nicht, Daten fehlen.

**Ursachen:**
1. Mehrere Server-Instanzen liefen gleichzeitig (Telegram 409 Conflict)
2. Keine automatische Selbstheilung bei Teil-Ausfällen
3. Health-Check nicht detailliert genug

**Loesung:**
1. **Process Lock** (`data/.scanner.lock`) verhindert doppelte Instanzen
2. **Watchdog Service** prueft alle 30s kritische Komponenten und heilt automatisch
3. **Detaillierter Health Check** zeigt genau was funktioniert und was nicht

**Lektion:** Bei Production-Software IMMER Stabilitaetsmechanismen einbauen:
- Single-Instance Enforcement
- Health Checks mit granularem Status
- Automatische Selbstheilung
- Klare Fehlermeldungen fuer den User

---

## Grundprinzipien

- **Einfachheit zuerst**: Jede Änderung so simpel wie möglich
- **Keine Faulheit**: Ursachen finden, keine temporären Fixes
- **Minimaler Eingriff**: Nur das Nötige berühren, keine neuen Bugs

---

## Referenzen

- **PLAN.md**: Detaillierter Implementierungsplan
- **poly_data**: https://github.com/warproxxx/poly_data
- **Polymarket API**: https://docs.polymarket.com
