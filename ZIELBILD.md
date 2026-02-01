# EDGY ALPHA - ZIELBILD & TASK-TRACKER

## ERFOLGSKRITERIEN (alle müssen 100% sein)

| # | Task | Status | Beschreibung |
|---|------|--------|--------------|
| 1 | Polymarket API | ✅ DONE | Echte Märkte werden angezeigt |
| 2 | Deutsche Sprache | ✅ DONE | Alle UI-Texte auf Deutsch |
| 3 | Almanien-Modul | ✅ DONE | Dawum, RSS, Bundestag live anzeigen |
| 4 | Wallet verbinden | ✅ DONE | Echte USDC-Balance anzeigen |
| 5 | Status-Dots ehrlich | ✅ DONE | Keine Fake-Dots mehr |
| 6 | Telegram fixen | 🔄 WIP | /scan zeigt echte Märkte |
| 7 | Trading aktivieren | ❌ TODO | Buy-Buttons funktionieren |
| 8 | Session-Login | ✅ DONE | Kein nerviges Basic Auth |

---

## OFFENE TASKS

### Task 3: Almanien-Modul komplett aktivieren ✅
- [x] Dawum-Umfragen im UI mit echten Werten anzeigen
- [x] RSS-News im UI anzeigen
- [x] Bundestag-Feed anzeigen (oder "nicht konfiguriert")
- [x] API-Endpoints liefern echte Daten

### Task 4: Wallet verbinden ✅
- [x] Echte USDC-Balance von Polygon lesen
- [x] Wenn kein Private Key: "Nicht konfiguriert" anzeigen
- [x] Balance im UI anzeigen
- [ ] Balance im Telegram anzeigen (→ Task 6)

### Task 6: Telegram komplett fixen
- [ ] /scan zeigt echte Märkte mit Odds
- [ ] /status zeigt echte System-Infos
- [ ] Almanien-Alerts wenn neue Umfrage

### Task 7: Trading aktivieren
- [ ] Buy-Buttons zeigen Feedback
- [ ] Wenn nicht konfiguriert: klare Fehlermeldung
- [ ] Später: echte CLOB API Integration

---

## ALMANIEN-VERACHTUNG EINGEBAUT?

- [x] Boot-Sequenz: "Almanien-Vorsprung aktiviert"
- [x] Telegram: "Almanien-Vorsprung aktiviert"
- [ ] Fehler-Messages mit Almanien-Humor
- [ ] Leere Zustände mit Almanien-Humor

---

## CREDENTIALS (auf VPS in .env)

```
WEB_USERNAME=tobsi
WEB_PASSWORD_HASH=marion#999edgy
```

---

## NÄCHSTER SCHRITT

Task 3: Almanien-Modul im UI aktivieren
- Dawum-Polls müssen echte Werte zeigen
- RSS-News müssen angezeigt werden
