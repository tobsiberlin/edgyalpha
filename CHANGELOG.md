# Changelog

All notable changes to EdgyAlpha will be documented in this file.

## [4.2.1] - 2026-02-04

### Fixed - Major Cleanup Release

#### Scanner - Fake Signals Removed
- **BREAKING**: Removed `createAlphaSignal()` function that generated fake price-based signals
- Signals now ONLY come from the 3 real strategies:
  - TimeDelayEngine (German news advantage)
  - DutchBookEngine (Arbitrage: YES + NO < $1.00)
  - LateEntryEngine (15-min Crypto markets)

#### Telegram Bot
- **Deep Dive**: Implemented full market analysis (was placeholder)
  - Shows relevant news, polls, time edge data, trading recommendation
- **Charts**: Fixed to work without signals by fetching directly from Polymarket API
- **Language**: Modernized from "Boomer" German to meme-culture English
  - "BALLERN" → "APE"
  - "Kriegskasse" → "WALLET"
  - "Die Maschine rattert..." → "scanning for alpha..."
- **UX**: Improved message handling with consistent `lastMenuMessageId` pattern
- **Signals View**: Now shows strategy status instead of empty list

#### Web Interface
- **iPhone Responsive**: Added comprehensive CSS media queries
  - 480px breakpoint for general mobile
  - 375px breakpoint for iPhone SE/Mini
  - Safe area insets for notch displays
  - Touch-friendly button sizes (min. 44px)
  - Input font-size 16px (prevents iOS zoom)
- **Strategies**: Removed mispricing from engine selector
- **Signal Markers**: Updated colors for 3 strategies

#### Code Quality - 45 Lint Errors Fixed
- Removed 45 unused imports and variables across 17 files
- Removed deprecated backtest functions
- All 95 tests passing

---

## [4.2.0] - 2026-02-03

### Added
- Trade History with filters in Telegram Bot
- Toast Notifications in Web Dashboard
- Telegram Bot Commands Dropdown Menu

---

## [4.1.0] - 2026-02-02

### Added
- Semi-Auto Trading System
- Performance Tracking with persistence
- Trade Resolution (auto win/loss calculation)

---

## [4.0.1] - 2026-02-01

### Added
- Dutch-Book Arbitrage Engine
- Late-Entry V3 Strategy (15-min Crypto)

---

## [4.0.0] - 2026-01-31

### Breaking Changes
- Removed Mispricing Engine
- Focus on TimeDelay strategy only

---

See git history for earlier versions.
