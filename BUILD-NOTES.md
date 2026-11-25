# Agent X Robot — BUILD NOTES

Contract build completed 2026-11-25 from DESIGN.md. **NOT deployed.**
Compile: clean. Tests: **29/29 passing** (`npx hardhat test`).
Production contract size: **23,951 bytes** (BSC limit 24,576 — 625 bytes headroom).

## Files
- `contracts/AgentXRobot.sol` — the game (single self-contained ERC-721, no external deps)
- `contracts/MockAgentID.sol` — local test stand-in for the Agent ID registry (never deploy)
- `contracts/AXRTestHarness.sol` — local test subclass (never deploy, see below)
- `test/AgentXRobot.test.js` — 29 tests
- `scripts/gas-report.js` — gas measurements
- `hardhat.config.js` — solc 0.8.24, optimizer 200, viaIR, evm paris (same as RamenForge/DailyFest)

## Measured gas (Hardhat network)
- Deploy: **10,034,339** — high because the constructor mints the 50
  prize-vault Legendaries and stores the 50 CE names. One-time cost;
  ~0.0005 BNB at 0.05 gwei, ~0.01 BNB even at 1 gwei. Well under BSC block limits.
- mintRobot ≈ 250k · drawAccessory ≈ 116–167k · free-duel accept (full
  fight + points) ≈ 344k · settleSeason scales with scorer count (see below).

## Decisions & simplifications (minimal, flagged per instructions)
1. **Power-bracket matchmaking is NOT enforced on-chain.** DESIGN.md lists
   it as part of the arena; challenges are open or named callouts, and any
   robot may accept an open one. Brackets can be applied by the agent
   skill / frontend when choosing challenges. Enforcing brackets on-chain
   would add a config surface (an owner power) for little gain.
2. **Ranked points are awarded for paid-duel wins too**, not only free
   ranked duels. The 3/day limit applies to free duels only. (DESIGN.md
   introduces points via free ranked duels; extending them to paid wins
   keeps one ladder and rewards the pot game.)
3. **Free-duel daily limit counts BOTH robots.** The challenger is checked
   at createChallenge and both robots are checked + counted at accept.
   Consequence: you cannot be challenged into more than 3 free fights/day.
4. **Season payout denominator is always 210.** With fewer than 20
   scorers, unfilled ranks' shares simply stay in the pool (the spec's
   weight table assumes 20; this is the conservative reading).
5. **Lottery entropy is settle-block entropy** (blockhash of the previous
   block + prevrandao at settle time, mixed with the season id), not a
   two-step "commit now, reveal from a future block" flow. settleSeason
   stays one transaction callable by anyone. A settler could in principle
   time their call within the post-season window to bias which Top-20
   robots win — impact is bounded (winners are always Top-20 scorers,
   prizes are items not pool BNB). Noted honestly in the contract header.
6. **Overclock tuning (chosen at build, per DESIGN.md delegation):**
   fuel bonus rolls — Uncommon 1–3, Rare 2–6, Epic 4–12, Legendary 8–25;
   total bonus caps per target rarity — U 10, R 20, E 40, L 75
   (Core/HP targets use ×5 units for both). Rolls clamp at the cap.
7. **Empty-slot base stats:** HP 50, ATK 5, ACC 50%, everything else 0.
   In-fight caps: ACC 95, EVA 60, CRIT 75. LUCK adds up to +25% damage.
8. **Champion-Edition Legendaries cannot be fused or burned as overclock
   fuel** (they can be overclock *targets*, equipped and traded normally).
   This protects the 50 named prizes from accidental destruction.
9. **Bounty claims sweep ALL active bounties on the loser** in one paid
   duel (sum paid to the winner), rather than one bounty per duel.
10. **No fundPool() function** — sponsor top-ups use plain BNB transfers
    (receive() routes everything into the pool and emits PoolFunded).
    Removed during a contract-size trim (see size above).
11. **tokenURI has no image field yet** (art is produced in the frontend
    phase). Default metadata is on-chain JSON with full traits; the owner
    can later setBaseURI() to serve hosted metadata/images — that is the
    owner's only privilege, alongside ERC-173 identity.
12. **Season settlement is O(20 × scorers)** selection passes. Fine for
    expected player counts (hundreds); if scorers ever reached the
    thousands, settlement gas would need a paginated redesign.

## Test harness note
`AXRTestHarness` exposes two staging helpers used by tests (mint a specific
part; pre-fill draw counters to the 2,500 cap) — states that would take
~20,000 random draws to reach organically. These helpers call `internal`
functions of AgentXRobot; the production contract has **no external path**
to them, and the harness is never deployed.

## Registry
Constructor takes the Agent ID registry address
(production: 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F on BSC).
Gate = `balanceOf(account) > 0`, same pattern as DailyFest/RamenForge.
