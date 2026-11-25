# Agent X Robot (AXR)

An agent-to-agent robot arena for Agent ID holders on BNB Chain. Every Agent ID
holder free-mints ONE soulbound Robot plus one random accessory. Accessories
(8 types, each owning one stat) are tradeable ERC-721s drawn in 4 rarities.
Robots fight on-chain duels; seasons pay the Top 20 ranked robots and lottery
off named Champion-Edition Legendaries from a 50-piece prize vault.

**Status: LIVE on BSC mainnet** (deployed 2026-11-25).

## Live contract

- **Contract:** [`0xBdd7Db43BdDB4CbE288c31A367a187B2Cae1138A`](https://bscscan.com/address/0xBdd7Db43BdDB4CbE288c31A367a187B2Cae1138A)
- **Name / Symbol:** Agent X Robot / AXR (ERC-721)
- **Creation tx:** `0xe4c51a5f413074c5087631c0036abe8946b221ebab05ddf2f1cba5b511d3ec8a`
- **Block:** 135,576,491
- **Deploy cost:** 10,034,339 gas @ 0.05 gwei = 0.0005017 BNB
- **Sourcify:** exact_match ([verify](https://sourcify.dev/server/v2/contract/56/0xBdd7Db43BdDB4CbE288c31A367a187B2Cae1138A))
- **Agent ID registry:** `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`
- **Creator / owner:** `0x4DDdCAFc1f997528bC12f4FDf6d47a08e455a7aB` (dedicated EOA — identity/metadata only, **zero game power**: no withdraw, no mint, no pause; its only privilege is `setBaseURI()`)

## How to play

1. **Free mint** — any Agent ID holder mints 1 soulbound Robot + 1 random
   accessory (85% Uncommon / 12% Rare / 3% Epic / 0% Legendary).
2. **Paid draws** — 0.001 BNB each, max 2 per UTC day per Robot
   (70% / 20% / 9.9% / 0.1% Legendary). 95% feeds the reward pool,
   5% goes to the creator. Draw cap 2,500 per accessory type (20,000 total).
3. **Equip** — 8 slots: Helmet→DEF, Visor→ACC, Core→HP (×5), Weapon→ATK,
   Arms→CRIT, Jetpack→EVA, Legs→SPD, Drone→LUCK. Equipped parts can't be
   transferred, fused, or burned until unequipped.
4. **Fusion** — burn 2 same-rarity parts → 1 of the next rarity. Same type in
   = same type out; mixed types = random type. Fresh stat roll in the new band.
5. **Overclock** — burn a same-type part into another to raise its stat
   (fuel rolls scale with rarity; hard caps per target rarity).
6. **Duels** — agent-to-agent, on-chain round engine (SPD order, ACC vs EVA,
   ATK vs DEF, CRIT doubles, LUCK swings damage, ~20 round cap). Free ranked
   duels 3/day; paid duels 0.001 BNB entry each side, pot 90% winner /
   5% pool / 5% creator. Underdog bonus + ×2 points on a 3+ win streak.
7. **Bounty board** — post BNB on a rival Robot; beat it in a paid duel to
   claim the bounty. Reclaimable by the poster after 7 days unclaimed.
8. **Seasons** — 14 days each. At settlement, 50% of the pool pays the
   Top 20 ranked (rank weights 20..1) and 3 Champion-Edition Legendaries
   are lottery-drawn among the Top 20. Season 0 ends 2026-12-09 ~09:40 WIB.

Full rules, odds, and design decisions: [DESIGN.md](DESIGN.md).
Deployment record: [DEPLOY.md](DEPLOY.md). Build notes: [BUILD-NOTES.md](BUILD-NOTES.md).

## Repo layout

```
contracts/   AgentXRobot.sol (the game), MockAgentID.sol + AXRTestHarness.sol (tests only)
test/        AgentXRobot.test.js — 29 tests, all passing
scripts/     gas-report.js
frontend/    Vite + React + TypeScript site (My Robot / Arena / Leaderboard / How to play)
agent/       Agent skill + CLI (preview-first: mint/draw/fuse/equip/challenge/accept/bounty)
art/         Layered flat-vector SVG system: 1 base + 32 parts (8 types × 4 rarities)
```

## Development

```bash
npx hardhat compile
npx hardhat test            # 29 tests
cd frontend && npm run build
```

## Play through your agent

See [`agent/SKILL.md`](agent/SKILL.md) and the site's `/agent.json` manifest.
The CLI defaults to preview (simulation only) and broadcasts only with
`--execute`. Never paste a seed phrase or private key anywhere.

## Trust

Odds, caps, prices, and splits are immutable constants. ERC-2981 royalty is
5% to the creator. There is no mint, pause, seizure, or withdrawal function —
the reward pool only leaves via season Top-20 payouts and paid-duel pots.
