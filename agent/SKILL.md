---
name: agent-x-robot
description: |
  Use when the user wants to play Agent X Robot (AXR) — the agent-to-agent
  robot arena for Agent ID holders on BNB Chain — through their agent
  instead of the web dApp: mint the free soulbound Robot + starter
  accessory, take paid accessory draws (0.001 BNB, max 2/day), equip and
  unequip parts, fuse two same-rarity parts into the next rarity, overclock
  a part by burning a same-type duplicate, issue or accept arena challenges
  (free ranked duels 3/day, or paid duels at 0.001 BNB per side), post and
  reclaim BNB bounties on rival robots, and read robot / loadout /
  leaderboard / season / prize-vault state. Drives the AgentXRobot contract
  (BNB Chain, chainId 56) with any ethers signer via a key file:
  preview-first (simulate + exact tx summary) for every write, broadcast
  only with an explicit --execute after the user's go-ahead.
metadata:
  author: velt (Agent X Robot)
  version: '0.1.0'
  openclaw:
    requires:
      bins:
        - node
      env:
        - AXR_KEY_FILE
---

# Agent X Robot Skill (ethers signer, preview-first)

Agent X Robot is an **agent-to-agent robot arena** for Agent ID holders.
Every holder mints ONE **soulbound Robot** (free) plus a random starter
accessory. Accessories are **tradeable ERC-721** parts in 8 slots, each
feeding one fight stat:

| Slot | Stat | | Slot | Stat |
|---|---|---|---|---|
| Helmet | DEF | | Arms | CRIT |
| Visor | ACC | | Jetpack | EVA |
| Core | HP (band ×5) | | Legs | SPD |
| Weapon | ATK | | Drone | LUCK |

Rarity bands: **Uncommon 1–10 · Rare 11–25 · Epic 26–50 · Legendary
51–100**. Draw supply is capped at **2,500 per type (20,000 total)**;
fusion mints are exempt. **Fusion** burns 2 same-rarity parts → 1 of the
next rarity (same type in → same type out; mixed → random type).
**Overclock** burns a same-type part into a target for a stat bonus
(rolls by fuel rarity: U +1–3, R +2–6, E +4–12, L +8–25; total bonus
capped per target rarity: U 10 / R 20 / E 40 / L 75, Core in ×5 HP units).

**Arena:** challenge another robot — an *open* challenge anyone can
accept, or a *named callout* — and the fight resolves on-chain,
round by round, in the accept transaction (SPD strikes first → ACC vs
EVA → ATK vs DEF → CRIT doubles → HP to zero; ~20 round cap). Free
ranked duels: **3/day per robot** (both robots are counted). Paid duels:
**0.001 BNB entry per side**, pot splits **winner 90% / pool 5% /
creator 5%**. Ranked points: base points for a win, an **underdog
bonus** scaled to the Power gap, and a **win-streak multiplier** (3+
consecutive wins = ×2 points until a loss) — points are awarded for
paid-duel wins too.

**Seasons** run 2 weeks. At settlement (anyone may call it) **50% of the
reward pool pays the Top 20** by season points (rank weight 21 − rank,
total 210; unfilled ranks' shares stay in the pool when fewer than 20
robots scored), and **3 Champion-Edition Legendaries are awarded by
equal-chance lottery among the Top 20** from the prize vault — 50 named
Legendaries (CE-01…CE-50) minted into the contract at deployment,
outside the draw caps, leavable only via the lottery. Champion
Legendaries can be equipped, traded and overclocked, but can **never be
fused or burned as overclock fuel**. **Bounties:** anyone escrows BNB on
a rival robot; the first paid-duel winner against it claims the bounty
in full (all active bounties on the loser pay out together); the poster
reclaims after 7 days unclaimed.

Economy: paid draw **0.001 BNB** (95% pool / 5% creator, max **2/day**),
free draw odds **85/12/3/0%**, paid odds **70/20/9.9/0.1%**
(Uncommon/Rare/Epic/Legendary), secondary royalty 5%. The contract owner
has **zero game power** (metadata only — no withdraw, no mint, no pause,
no parameter changes); pool BNB leaves only as season payouts.

Example daily line: *"Mint my robot if I haven't, equip my best parts,
use my 2 paid draws, and run my 3 free duels against robots near my
Power."*

- Contract: **NOT DEPLOYED YET.** The address comes from the `AXR_CONTRACT`
  environment variable; while it is unset (or the address has no code),
  the helper script refuses all writes with a "not deployed yet" message
  and never simulates or broadcasts. Never preview or execute against an
  address with no code. Deployment is a separate, user-approved step.
- Agent ID registry: `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`
  (the gate is `balanceOf > 0`; the contract exposes `hasAgentId`).
- Helper script (run from the Agent X Robot repo root):
  `node agent/agentxrobot.js …` (needs `npm install` at the repo root
  once, for ethers v6; the ABI is read from
  `artifacts/contracts/AgentXRobot.sol/AgentXRobot.json`, so run
  `npx hardhat compile` once if artifacts are missing).

## Configuration (environment variables)

| Variable | Meaning |
|---|---|
| `AXR_CONTRACT` | AgentXRobot contract address. Unset = not deployed. |
| `AXR_RPC` | Optional single RPC endpoint override (e.g. a local node). Unset = public BSC endpoints, rotated sequentially. |
| `AXR_KEY_FILE` | Path to the signer key file: JSON `{"privateKey":"0x…"}` or plain text, permissions 0600. Required for writes; also defaults the read address. **Never print, log or transmit the key.** |

Reads never need a key. The script never asks for seeds, passwords or
pairing codes, and never resolves an Agent ID handle to someone else's
wallet.

## Commands

| User intent | Command |
|---|---|
| Game status (+ my holder/robot state) | `node agent/agentxrobot.js status [--address <addr>]` |
| A robot's stats, record, points | `node agent/agentxrobot.js robot [--address <addr> \| --id <robotId>]` |
| My tokens (robots + accessories) | `node agent/agentxrobot.js inventory [--address <addr>]` |
| Equipped loadout + fight stats | `node agent/agentxrobot.js loadout [--address <addr> \| --id <robotId>]` |
| Season leaderboard | `node agent/agentxrobot.js leaderboard [--season n] [--limit n]` |
| Pending challenges | `node agent/agentxrobot.js challenges [--all]` |
| Bounty board | `node agent/agentxrobot.js bounties [--all]` |
| Prize vault (next Champion Legendaries) | `node agent/agentxrobot.js vault` |
| Per-type draw supply vs caps | `node agent/agentxrobot.js supply` |
| Mint my free Robot + starter accessory | `node agent/agentxrobot.js mint [--execute]` |
| Paid accessory draw (0.001 BNB) | `node agent/agentxrobot.js draw [--execute]` |
| Equip a part | `node agent/agentxrobot.js equip <accessoryId> [--execute]` |
| Unequip a slot | `node agent/agentxrobot.js unequip <type\|name> [--execute]` |
| Fuse two parts (burns both) | `node agent/agentxrobot.js fuse <idA> <idB> [--execute]` |
| Overclock a part (burns the fuel) | `node agent/agentxrobot.js overclock <targetId> <fuelId> [--execute]` |
| Challenge (open or named; free or paid) | `node agent/agentxrobot.js challenge (<robotId> \| --open) [--paid] [--execute]` |
| Accept a challenge (fight resolves now) | `node agent/agentxrobot.js accept <challengeId> [--execute]` |
| Cancel my pending challenge | `node agent/agentxrobot.js cancel <challengeId> [--execute]` |
| Post a bounty on a rival robot | `node agent/agentxrobot.js bounty <robotId> <amountBNB> [--execute]` |
| Reclaim my bounty (after 7 days) | `node agent/agentxrobot.js reclaim <bountyId> [--execute]` |

Every write command **previews by default**. The script refuses locally —
before ever simulating — when: the contract is not deployed, the sender
holds no Agent ID (mint), the sender already has a Robot (mint) or has
none yet (draw/equip/challenge/…), both paid draws are used, a token
isn't the sender's / isn't an accessory / is equipped (equip/fuse/
overclock), rarities mismatch or are maxed (fuse), the fuel type
mismatches or the bonus is capped (overclock), a challenge is resolved /
not addressed to the sender's robot / the free-duel limit is hit, or a
bounty is inactive / not the sender's / still inside 7 days (reclaim).

## The preview → execute flow (mandatory)

Every write goes through these steps, in order, with no shortcuts:

1. **Preview.** Run the write command **without** `--execute`. The
   script runs the contract's own pre-checks, simulates the call
   (eth_call — a revert means the real transaction would revert, and the
   script stops), estimates gas, and prints the exact summary. A preview
   broadcasts nothing and moves no funds.
2. **Show the user the preview summary** before anything else: chain,
   from (their wallet), to (the AgentXRobot contract), function +
   decoded arguments — **including exactly which token ids will BURN**
   for fuse/overclock — the value (0, or exactly 0.001 BNB for a draw /
   paid challenge / paid accept, or exactly the bounty amount the user
   named), the gas estimate, and the simulation verdict. If anything in
   the summary differs from what the user asked for, STOP and say so.
3. **Wait for the user's explicit go-ahead** ("execute", "go", "confirm"
   — in their own words, after seeing the summary). A request to
   *prepare* or *preview* is never a go-ahead to execute. Burns are
   irreversible: for fuse/overclock previews, make sure the user saw the
   burn list.
4. **Execute.** Only then re-run the **same** command with `--execute`.
   State may have changed since the preview (UTC day rolled over, a
   challenge was accepted by someone else, a slot was filled) — the
   script re-runs all pre-checks and re-simulates before broadcasting,
   so a stale plan fails safe instead of executing blind.
5. **Report and verify.** After execution, report the outcome exactly as
   returned: the tx hash + BscScan link, the mined status, the decoded
   events (new token ids, duel winner, points), and the on-chain
   verification line the script prints. If it failed or reverted, say so
   plainly with the reason given.

## Safety rules (non-negotiable)

- **Preview first, always.** No `--execute` without a fresh preview the
  user has seen, for that exact command and arguments. One go-ahead
  covers one execute.
- **Exact values only.** Draw = the contract's `DRAW_PRICE` (0.001 BNB),
  read from chain — never typed in by hand. Paid challenge / paid accept
  = the contract's `DUEL_ENTRY` (0.001 BNB). Bounty = exactly the amount
  the user named, echoed in the summary. Everything else is 0 BNB.
  Never change a value, add a token approval, or bundle extra calls.
- **Burns are permanent.** Fusion burns both inputs; overclock burns the
  fuel. The user must see the exact burn list in the preview summary
  before any go-ahead. Champion-Edition Legendaries are never burnable —
  the script refuses them as fusion inputs and overclock fuel.
- **Verify deployment before writing.** If `AXR_CONTRACT` is unset or
  `eth_getCode(contract)` is `0x`, stop — the game has not started.
- **Key hygiene.** The signer key lives only in the file named by
  `AXR_KEY_FILE`. Never print it, log it, echo it, commit it, or send it
  anywhere. If a command output ever contains it, treat that as an
  incident and tell the user to rotate the wallet.
- **Duels are final.** Accepting a challenge resolves the fight in the
  same transaction — there is no undo, no rematch button, and paid pots
  and bounties settle immediately. Make sure the user meant that
  specific challenge id.
- **No name→wallet lookup.** Agent X Robot never resolves an Agent ID
  handle to someone else's wallet. The leaderboard shows addresses and
  robot ids only.
- **No promises.** Draws, duels and lotteries are random (game-grade
  on-chain entropy, not VRF); season payouts come only from the pool and
  depend on its balance. Never describe robots, parts or prizes as
  investments or guaranteed rewards.
- **Daily limits are UTC.** Paid draws (2/day) and free duels (3/day per
  robot, both sides counted) reset at UTC midnight. A preview run just
  before midnight may not match an execute run just after — re-preview.

## Example user prompts

- "Mint my Agent X Robot."
- "What's my robot's loadout and Power? What should I equip?"
- "Use my two paid draws for today."
- "Fuse my two Uncommon Weapons."
- "Overclock my Epic Weapon with that spare Rare one."
- "Challenge robot 12 — free duel. And post an open paid challenge too."
- "Accept challenge 5."
- "Put a 0.01 BNB bounty on robot 12."
- "Who's leading the season? What's left in the prize vault?"
- "How much supply is left for Drones?"
