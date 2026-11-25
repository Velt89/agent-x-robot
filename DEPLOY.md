# Agent X Robot — DEPLOYMENT RECORD

**Status: LIVE on BSC mainnet — 2026-11-25 09:40 WIB**

## Contract
- **Address:** `0xBdd7Db43BdDB4CbE288c31A367a187B2Cae1138A`
- **Name / Symbol:** Agent X Robot / AXR (ERC-721)
- **Creation tx:** `0xe4c51a5f413074c5087631c0036abe8946b221ebab05ddf2f1cba5b511d3ec8a`
- **Block:** 135,576,491
- **Gas used:** 10,034,339 (exactly the measured estimate) at 0.05 gwei
- **Actual cost:** 0.00050171695 BNB (~$0.27)
- **Deployer (owner/creator):** `0x4DDdCAFc1f997528bC12f4FDf6d47a08e455a7aB` (dedicated EOA; seed/key only in `wallet/wallet.json`, 0600, never through chat)
- **Deployer balance after deploy:** 0.00045869312 BNB (funded 0.00096041, spent 0.00050171695)
- **Agent ID registry (constructor arg):** `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`
- **Compiler:** solc 0.8.24+commit.e11b9ed9, optimizer 200 runs, viaIR, evm paris
- **Runtime size:** 23,951 bytes (limit 24,576)

## On-chain verification (all read live after 1 confirmation)
- `getCode` — 23,951 bytes, non-empty
- `agentIdRegistry()` = `0x60B9...022F` ✓
- `owner()` = `creator()` = deployer `0x4DDd...a7aB` ✓
- `totalMinted()` = 50, `robotCount()` = 0, `totalDrawn()` = 0
- `vaultRemaining()` = 50 / `VAULT_SIZE()` = 50 — all 50 Champion Legendaries held by the contract (`balanceOf(contract)` = 50; `ownerOf(0)` and `ownerOf(49)` = contract)
- `championName(0)` = SUNFALL, `championName(1)` = BASTION, `championName(49)` = APEX
- `DRAW_PRICE()` = 0.001 BNB, `DRAW_CAP_PER_TYPE()` = 2,500, `rewardPool()` = 0 BNB
- Token IDs: vault Legendaries are 0–49 (`championName(50)` reverts "token does not exist" — expected, not an error)

## Seasons
- `seasonStart()` = 1795574432 = 2026-11-25 02:40:32 UTC (deploy block time)
- `SEASON_LENGTH()` = 1,209,600 s (14 days) — **Season 0 ends 2026-12-09 ~02:40 UTC / 09:40 WIB**
- `currentSeason()` = 0

## Sourcify verification
- **exact_match** on match + creationMatch + runtimeMatch
- matchId `59879359`, verified 2026-11-25T02:42:21Z
- Sourcify: https://sourcify.dev/server/v2/contract/56/0xBdd7Db43BdDB4CbE288c31A367a187B2Cae1138A
- BscScan: https://bscscan.com/address/0xBdd7Db43BdDB4CbE288c31A367a187B2Cae1138A
- Sourcify auto-forwarded a verification to BscScan (external id `87m5tmr7vtvv8521i5sa7dqvaksjnxmqihqi8nursqmuufdzli`) — landing unconfirmed from here; if source isn't showing on BscScan's Code tab, BscScan-native verify needs the user's own BscScan account with the std-JSON + constructor args.

## Notes
- No other tx was sent from the deployer (deploy only, per the tight balance).
- First Sourcify attempt failed on a bad `compilerVersion` ("0.8.24" without commit suffix); retried with the full `0.8.24+commit.e11b9ed9` from build-info and passed.
- `vaultPreview(0)` returns `[]` on-chain — cosmetic; `vaultRemaining()` + `championName()` are the authoritative vault reads.

## Next steps (in order)
1. Frontend config flip: set `AXR_ADDRESS` = `0xBdd7Db43BdDB4CbE288c31A367a187B2Cae1138A`, `AXR_DEPLOYED = true`, `AXR_START_BLOCK` = 135,576,491 in `frontend/src/config.ts`, rebuild.
2. Agent CLI go-live: `export AXR_CONTRACT=<address>` (no code change needed).
3. GitHub push (new repo `Velt89/agent-x-robot`, bulk push, raw-verify).
4. Vercel import (user tap) — site live.
5. Element/OpenSea collection branding with the dedicated wallet (user imports seed into MetaMask; logo/banner/description/royalty 5%).
6. Boltbook launch post.
7. Seed play (user's main wallet W mints its robot via the agent CLI) once the site is live.
