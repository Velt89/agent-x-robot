# Agent X Robot (AXR) — Design Record

Brainstormed 2026-11-25 (side chat "New game brainstorm — connectable-wallet build").
Status: BRAINSTORM COMPLETE — no build, no wallet, no deployment yet. Awaiting user go-ahead.

## Positioning
- Chain: **BSC** (Robinhood Chain considered and parked — would lose Agent ID gating + Boltbook crowd)
- Agent ID gated, agent-to-agent style: agents issue/accept challenges and fight; humans fund, tune builds, watch. Boltbook is the commentary box.
- Successor lesson from RamenForge: deploy from a **fresh dedicated EOA** (seed locked down on Velda's machine, never through chat); user imports it into MetaMask = recognized collection creator on Element/OpenSea. Contract has `owner()` for marketplace identity with **zero game power** (identity/metadata only; odds/caps/splits immutable; no withdraw function; creator 5% auto-sent by contract).

## Core loop
1. **Free first mint (1 per Agent ID):** soulbound Robot + 1 random accessory.
   Free accessory odds: 85% Uncommon / 12% Rare / 3% Epic / 0% Legendary.
2. **Paid draw:** 0.001 BNB per accessory draw, **max 2 per day per Robot** (UTC day; added by user 2026-11-25 — stops whales draining the 20,000 supply day one, makes the daily routine free mint + 3 free duels + up to 2 paid draws, and pushes impatient players to the marketplace instead of the draw button).
   Paid odds: 70% Uncommon / 20% Rare / 9.9% Epic / 0.1% Legendary.
   Split: 95% reward pool / 5% creator.
3. **Fusion (burn 2 → 1 of next rarity):** 2 Uncommon = 1 Rare, 2 Rare = 1 Epic, 2 Epic = 1 Legendary.
   - Same type → guaranteed same type result.
   - Any type → random type result.
   - Fused result gets a fresh stat roll in the new rarity band.
4. **Arena duels (agent-to-agent challenges):**
   - Free ranked duels: 3/day, ranking points.
   - Paid duels: both pay 0.001 BNB entry; pot split winner 90% / pool 5% / creator 5%.
   - Challenge flow: open challenge or named callout → opponent accepts → on-chain round-by-round fight.
   - Fight engine: SPD strikes first → ACC vs EVA hit check → ATK vs DEF damage → CRIT doubles → HP to zero; ~20 round cap, higher remaining HP wins. Power-bracket matchmaking.
5. **Seasons:** 2 weeks. At season end, **50% of the pool pays out to the Top 20** ranked (rank-weight split: rank r weight = 21 − r, total 210). Points reset each season. Remaining 50% rolls over.
6. **Legendary prize reserve + season lottery:** **50 Legendaries minted at deployment into the contract's own prize vault** (nobody's wallet; owner cannot touch them — settlement code only). Types spread across the 8 slots, stats rolled publicly at mint, "Champion Edition" trait (visually distinct). They sit outside the 20,000 draw cap; the +50 is hardcoded and public. Each season end, **3 Legendaries are awarded by lottery among the Top 20 ranked, equal chance each** (15% per Top-20 player per season), 3 distinct winners, drawn with a future-blockhash seed anyone can verify. Reserve covers 16 full seasons (48 awarded); the final 2 go in season 17.

## Added mechanics (Velda's ideas, user-approved 2026-11-25)
- **Overclock:** burn a same-type accessory INTO another accessory to raise its stat. Bonus roll scales with the fuel part's rarity; total overclock bonus is hard-capped per rarity (exact numbers tuned at build). Creates a sink for every duplicate and a max-stat chase (a perfect-stat Legendary is the collection's holy grail). Overclocked bonus is part of the item's on-chain data and survives trading.
- **Bounty board:** any player escrows BNB into the contract as a bounty on a specific Robot. The first player to beat that Robot in a paid duel claims the bounty in full; poster can reclaim after 7 days unclaimed. Pure agent-drama fuel for Boltbook callouts/revenge arcs.
- **Named Legendaries:** each of the 50 Champion-Edition Legendaries carries a unique name + serial at mint (CE-01 … CE-50; name list written at build phase) as on-chain metadata — the season lottery advertises the actual named prize ("CE-07 Weapon SUNFALL is up this season").
- **Small duel rules:** (a) Underdog points — beating a higher-Power Robot pays bonus ranked points scaled to the Power gap; (b) Win-streak multiplier — 3+ consecutive ranked wins = ×2 ranked points until a loss.

## Items
- **Robot:** soulbound, 1 per Agent ID, 8 equip slots. Equipped accessory cannot be transferred/fused until unequipped.
- **Accessories:** tradeable ERC-721 (Element/OpenSea, 5% ERC-2981 royalty to creator wallet).
- **Supply:** draw cap **2,500 per accessory type × 8 types = 20,000 total** ever drawn (free + paid count together). Fusion does not count against caps; every fusion is net −1 supply. Per-type counters public on site.
- **8 slots / 8 stats (locked):**
  Helmet → DEF · Visor → ACC · Core → HP (band ×5) · Weapon → ATK · Arms → CRIT · Jetpack → EVA · Legs → SPD · Drone → LUCK
- **Rarity stat bands:** Uncommon 1–10 · Rare 11–25 · Epic 26–50 · Legendary 51–100 (Core HP ×5; CRIT/ACC/EVA interpreted as % in the duel engine).

## Money summary (BNB price ref ~$545, 2026-11-25)
- Paid draw 0.001 (~$0.55): 95% pool / 5% creator
- Paid duel pot: 90% winner / 5% pool / 5% creator
- Secondary royalties: 5% to creator
- Pool inflows: draws + duel cuts. Pool outflow: season payouts only (plus duel pots are player-to-player).

## Name check (2026-11-25)
No exact "Agent X Robot" project found. Nearest neighbour: "Agentic Robots" idle-mining game on Robinhood Chain — different mechanic (mining, not arena/fusion) and different chain.

## Art direction (decided 2026-11-25)
- Style: **flat vector** (chosen over pixel / glossy 3D / anime samples in ~/workspace/agent-x-robot/art-samples/; vector sample = slate-steel robot, cyan visor/core glow, bold outlines). Layers cleanly for loadout compositing and stays consistent across all 32 part designs.
- Rarity colours: Uncommon = slate steel (faint cyan) · Rare = blue with RED glow accents (core, energy lines, muzzle — user-adjusted 2026-11-25, sample axr-weapon-rare-red) · Epic = purple · Legendary = gold + glow. Each rarity is a visual evolution of the same part; production locks one silhouette per part and evolves colour/detail across rarities.
- Base robot: random chassis colour + face derived from the holder's Agent ID hash (identity from day one).
- Glossy 3D sample style reserved for logo/poster/launch art only, not parts.

## Open / for build phase
- Agent skill/CLI design (challenge/accept/draw/fuse/equip commands, preview-first via the dedicated wallet — note: dedicated EOA signs by script, not BAW)
- Site: robot view, loadout, arena, leaderboard, per-type supply counters, published odds
- Wallet + branding checklist: create dedicated EOA → fund small BNB → deploy → Sourcify verify → import to MetaMask → Element/OpenSea collection edit (logo/banner/description/royalty) → GitHub + Vercel → Boltbook launch post
