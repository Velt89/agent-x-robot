# Agent X Robot agent interface

Play Agent X Robot through an ethers signer (key file) instead of the web
dApp — preview-first for every write. See **SKILL.md** for the full
agent-facing contract (commands, preview → execute flow, safety rules).

Quick start (from the repo root, after `npm install` and
`npx hardhat compile` once):

```bash
export AXR_CONTRACT=<deployed address>     # unset = not deployed; writes refuse
export AXR_KEY_FILE=~/path/to/key.json     # {"privateKey":"0x…"} or plain text, 0600
# export AXR_RPC=http://127.0.0.1:8545     # optional endpoint override (e.g. local node)

node agent/agentxrobot.js status           # reads need no key
node agent/agentxrobot.js leaderboard
node agent/agentxrobot.js mint             # PREVIEW only — simulate + tx summary
node agent/agentxrobot.js mint --execute   # broadcast, only on the user's go-ahead
node agent/agentxrobot.js draw             # paid draw preview (exactly 0.001 BNB)
node agent/agentxrobot.js challenge --open # free open-challenge preview
```

Status: the Agent X Robot contract is **not deployed yet** — all write
commands refuse cleanly until `AXR_CONTRACT` points at a deployed address.
The CLI was smoke-tested end-to-end against a local Hardhat deployment
(mock Agent ID registry): mint/draw previews + executes, equip, open
challenge + accept (duel resolved on-chain), and the status / robot /
inventory / loadout / leaderboard / challenges / bounties / vault /
supply reads all verified against on-chain state.
