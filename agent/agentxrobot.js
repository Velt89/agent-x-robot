#!/usr/bin/env node
/**
 * Agent X Robot (AXR) — agent interface (ethers signer, preview-first).
 *
 * Lets an agent play Agent X Robot on BNB Chain with ANY ethers-compatible
 * signer, without opening the web dApp:
 *
 *   Reads (no key needed):
 *     node agent/agentxrobot.js status [--address <addr>]
 *     node agent/agentxrobot.js robot [--address <addr> | --id <robotId>]
 *     node agent/agentxrobot.js inventory [--address <addr>]
 *     node agent/agentxrobot.js loadout [--address <addr> | --id <robotId>]
 *     node agent/agentxrobot.js leaderboard [--season n] [--limit n]
 *     node agent/agentxrobot.js challenges [--all]
 *     node agent/agentxrobot.js bounties [--all]
 *     node agent/agentxrobot.js vault
 *     node agent/agentxrobot.js supply
 *
 *   Writes (PREVIEW by default — add --execute to broadcast):
 *     node agent/agentxrobot.js mint [--execute]
 *     node agent/agentxrobot.js draw [--execute]                       (exactly 0.001 BNB)
 *     node agent/agentxrobot.js equip <accessoryId> [--execute]
 *     node agent/agentxrobot.js unequip <type|typeName> [--execute]
 *     node agent/agentxrobot.js fuse <tokenA> <tokenB> [--execute]      (burns both)
 *     node agent/agentxrobot.js overclock <targetId> <fuelId> [--execute] (burns the fuel)
 *     node agent/agentxrobot.js challenge (<robotId> | --open) [--paid] [--execute]
 *     node agent/agentxrobot.js accept <challengeId> [--execute]        (0.001 BNB if paid)
 *     node agent/agentxrobot.js cancel <challengeId> [--execute]
 *     node agent/agentxrobot.js bounty <robotId> <amountBNB> [--execute]
 *     node agent/agentxrobot.js reclaim <bountyId> [--execute]
 *
 * Run from the repo root (uses the root node_modules ethers v6).
 *
 * CONFIGURATION (environment variables — nothing is hardcoded):
 *   AXR_CONTRACT  AgentXRobot contract address. Unset/zero = NOT DEPLOYED:
 *                 reads say so and every write refuses before simulating.
 *   AXR_RPC       Single RPC endpoint override (e.g. a local Hardhat node
 *                 http://127.0.0.1:8545). Unset = the public BSC endpoints
 *                 below, rotated sequentially with a browser User-Agent.
 *   AXR_KEY_FILE  Path to the signer's key file: JSON {"privateKey":"0x…"}
 *                 or a plain-text file containing only the key. Required
 *                 for write commands (and to default --address). The key
 *                 is loaded into memory only — it is NEVER printed, logged
 *                 or written anywhere by this script. Keep the file 0600.
 *
 * SAFETY MODEL (see agent/SKILL.md):
 * - Reads are plain RPC calls — no wallet, no keys, no signing.
 * - Writes are ALWAYS preview-first: without --execute the script only
 *   simulates the call (eth_call), estimates gas and prints the exact
 *   transaction summary (chain, from, to, function + args, value, gas).
 *   Nothing is broadcast and no funds move.
 * - --execute is a separate, explicit step to run ONLY after the user has
 *   seen the preview summary and said go. After broadcast the script
 *   verifies the on-chain effect and prints the tx hash.
 * - Values are exact and never improvised: draw = DRAW_PRICE read from the
 *   contract (0.001 BNB), paid challenge/accept = DUEL_ENTRY (0.001 BNB),
 *   bounty = exactly the amount the user named. Everything else is 0.
 * - Fusion burns both input tokens; overclock burns the fuel token. The
 *   previews print the exact burn list. Burns are irreversible.
 */
"use strict";

// Piping output into `head`/a closed stream should exit quietly, not crash.
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// ---------------------------------------------------------------- constants

const BSC_CHAIN_ID = 56;
const REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F"; // Agent ID registry (production BSC)
const BSCSCAN = "https://bscscan.com";

const AXR = (process.env.AXR_CONTRACT || ethers.ZeroAddress).trim();
const RPC_OVERRIDE = (process.env.AXR_RPC || "").trim();
const KEY_FILE = (process.env.AXR_KEY_FILE || "").trim();

// Accessory types: slot -> fight stat (Core stat is HP and already x5 on-chain)
const TYPES = ["Helmet", "Visor", "Core", "Weapon", "Arms", "Jetpack", "Legs", "Drone"];
const TYPE_STATS = ["DEF", "ACC", "HP", "ATK", "CRIT", "EVA", "SPD", "LUCK"];
const RARITIES = ["Uncommon", "Rare", "Epic", "Legendary"];
const BANDS = [[1, 10], [11, 25], [26, 50], [51, 100]]; // Core: x5
const STAT_ORDER = ["HP", "ATK", "DEF", "ACC", "EVA", "CRIT", "SPD", "LUCK"];

const RPC_ENDPOINTS = [
  "https://bsc-rpc.publicnode.com",
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-dataseed2.bnbchain.org",
];
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const ARTIFACT_PATH = path.join(
  __dirname, "..", "artifacts", "contracts", "AgentXRobot.sol", "AgentXRobot.json"
);
let axrAbi;
try {
  axrAbi = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8")).abi;
} catch {
  console.error(`ERROR: cannot read the AgentXRobot ABI at ${ARTIFACT_PATH} — run from the repo root after \`npm install\` / \`npx hardhat compile\`.`);
  process.exit(1);
}
const iface = new ethers.Interface(axrAbi);

// ------------------------------------------------------------------- errors

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function revertReason(e) {
  if (!e) return "unknown error";
  return e.reason || e.shortMessage || (e.info && e.info.error && e.info.error.message) || e.message || String(e);
}

// ---------------------------------------------------------------------- RPC
// Public-BSC mode: sequential endpoint rotation — ethers v6 JsonRpcProvider
// with a browser User-Agent (BSC dataseed 403s the default UA) and a hard
// request timeout (a hung RPC otherwise stalls forever). With AXR_RPC set
// (e.g. a local node), that single endpoint is used as-is.

let _provider = null;

function makeProvider(url, chainId) {
  const req = new ethers.FetchRequest(url);
  req.setHeader("User-Agent", BROWSER_UA);
  req.timeout = 20000;
  return chainId
    ? new ethers.JsonRpcProvider(req, chainId, { staticNetwork: true })
    : new ethers.JsonRpcProvider(req);
}

async function provider() {
  if (_provider) return _provider;
  if (RPC_OVERRIDE) {
    const p = makeProvider(RPC_OVERRIDE, null);
    await p.getBlockNumber();
    _provider = p;
    return p;
  }
  let lastErr;
  for (const url of RPC_ENDPOINTS) {
    const p = makeProvider(url, BSC_CHAIN_ID);
    try {
      await p.getBlockNumber();
      _provider = p;
      return p;
    } catch (e) {
      lastErr = e;
    }
  }
  fail(`all BSC RPC endpoints failed (last error: ${lastErr && lastErr.message})`);
}

async function axrReadContract() {
  const p = await provider();
  return new ethers.Contract(AXR, axrAbi, p);
}

async function read(fn, args = []) {
  const c = await axrReadContract();
  try {
    return await c[fn](...args);
  } catch (e) {
    if (RPC_OVERRIDE) throw e;
    // Rotate once on transport-level failure, then retry on the next endpoint.
    _provider = null;
    const c2 = await axrReadContract();
    return await c2[fn](...args);
  }
}

let _deployed = null;
async function isDeployed() {
  if (_deployed !== null) return _deployed;
  if (!ethers.isAddress(AXR) || AXR === ethers.ZeroAddress) {
    _deployed = false;
    return _deployed;
  }
  const p = await provider();
  _deployed = (await p.getCode(AXR)) !== "0x";
  return _deployed;
}

function notDeployedMessage() {
  const which = AXR === ethers.ZeroAddress ? "unset (zero address)" : AXR + ", which has no code on-chain";
  return (
    "the Agent X Robot contract is not deployed yet — AXR_CONTRACT is " + which + ". " +
    "Deployment is a separate, user-approved step. Nothing was simulated or broadcast."
  );
}

async function requireDeployed() {
  if (!(await isDeployed())) fail(notDeployedMessage());
}

// -------------------------------------------------------------------- signer
// The signer key comes ONLY from the file named by $AXR_KEY_FILE
// (JSON {"privateKey": "0x…"} or plain text). It is never printed.

let _wallet = null;
async function signer() {
  if (_wallet) return _wallet;
  if (!KEY_FILE) {
    fail(
      "no signer configured: set AXR_KEY_FILE to the path of a key file " +
        '(JSON {"privateKey":"0x…"} or plain text, permissions 0600). ' +
        "Read commands do not need a key; write commands do."
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(KEY_FILE, "utf8").trim();
  } catch (e) {
    fail(`cannot read AXR_KEY_FILE (${KEY_FILE}): ${e.message}`);
  }
  let key = raw;
  if (raw.startsWith("{")) {
    try {
      key = JSON.parse(raw).privateKey;
    } catch {
      fail(`AXR_KEY_FILE (${KEY_FILE}) is not valid JSON.`);
    }
  }
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(String(key).trim())) {
    fail(`AXR_KEY_FILE (${KEY_FILE}) does not contain a 32-byte private key (JSON {"privateKey": "0x…"} or plain text).`);
  }
  const p = await provider();
  _wallet = new ethers.Wallet(String(key).trim(), p);
  return _wallet;
}

/** Default read address: --address flag, else the signer address if a key file is set. */
async function resolveAddress(flagAddr) {
  if (flagAddr) {
    if (!ethers.isAddress(flagAddr)) fail(`--address is not a valid address: ${flagAddr}`);
    return ethers.getAddress(flagAddr);
  }
  if (KEY_FILE) {
    const w = await signer();
    return w.address;
  }
  fail("no address given and no AXR_KEY_FILE set — pass --address <addr> for read commands.");
}

// ------------------------------------------------------------------ helpers

function parseType(input) {
  if (input === undefined) fail("accessory type is required (0-7 or helmet/visor/core/weapon/arms/jetpack/legs/drone).");
  const s = String(input).trim().toLowerCase();
  if (/^[0-7]$/.test(s)) return Number(s);
  const idx = TYPES.findIndex((t) => t.toLowerCase() === s);
  if (idx >= 0) return idx;
  fail(`unknown accessory type "${input}". Use 0-7 or ${TYPES.map((t) => t.toLowerCase()).join("/")}.`);
}

function parseTokenId(input, what = "token id") {
  if (input === undefined || !/^\d+$/.test(String(input))) fail(`${what} must be a non-negative integer, got "${input}".`);
  return BigInt(input);
}

function takeFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return { value: null, rest: argv };
  return { value: argv[i + 1], rest: argv.filter((_, j) => j !== i && j !== i + 1) };
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function stripFlags(argv, names) {
  return argv.filter((a) => !names.includes(a));
}

function fmtToken(t) {
  // tokenInfo: [kind, accType, rarity, stat, ocBonus, serial, champion, chassis, equipped]
  const [kind, accType, rarity, stat, ocBonus, serial, champion] = t;
  if (Number(kind) === 0) return `Robot #${serial}`;
  const base = `${RARITIES[Number(rarity)]} ${TYPES[Number(accType)]} (${TYPE_STATS[Number(accType)]} ${stat}${Number(ocBonus) > 0 ? ` +${ocBonus} oc` : ""})`;
  return champion ? `${base} — CHAMPION EDITION CE-${String(serial).padStart(2, "0")}` : base;
}

async function tokenLine(id) {
  const t = await read("tokenInfo", [id]);
  const owner = await read("ownerOf", [id]);
  return { t, owner, line: `#${id} ${fmtToken(t)} · owner ${owner}${t[8] ? " · EQUIPPED" : ""}` };
}

/** Resolve a robot id from --id or from an owner's address. */
async function resolveRobot({ flagId, flagAddr }) {
  if (flagId !== null && flagId !== undefined) return parseTokenId(flagId, "robot id");
  const addr = await resolveAddress(flagAddr);
  const [robotId, has] = await read("robotOf", [addr]);
  if (!has) fail(`${addr} has no Robot yet — mint one first (\`mint\`).`);
  return robotId;
}

// -------------------------------------------------------------- read commands

async function cmdStatus(argv) {
  const { value: flagAddr } = takeFlag(argv, "--address");
  const p = await provider();
  const net = await p.getNetwork();
  console.log(`chain:              ${net.name || "unknown"} (chainId ${net.chainId})`);
  console.log(`contract:           ${AXR}`);
  if (!(await isDeployed())) {
    console.log("Agent X Robot:      NOT DEPLOYED YET — no game state exists on-chain.");
    console.log(`Agent ID registry:  ${REGISTRY} (production BSC) — deployment is a separate, user-approved step.`);
    return;
  }
  const season = await read("currentSeason", []);
  const robots = await read("robotCount", []);
  const drawn = await read("totalDrawn", []);
  const pool = await read("rewardPool", []);
  const paidOut = await read("totalPoolPaidOut", []);
  const vault = await read("vaultRemaining", []);
  const drawPrice = await read("DRAW_PRICE", []);
  const duelEntry = await read("DUEL_ENTRY", []);
  console.log(`season:             ${season} (2-week seasons; settle pays 50% of pool to Top 20 + 3 vault Legendaries by lottery)`);
  console.log(`robots minted:      ${robots}`);
  console.log(`accessories drawn:  ${drawn} / 20000 (cap 2500 per type)`);
  console.log(`reward pool:        ${ethers.formatEther(pool)} BNB (total paid out: ${ethers.formatEther(paidOut)} BNB)`);
  console.log(`prize vault:        ${vault} / 50 Champion-Edition Legendaries remaining`);
  console.log(`paid draw price:    ${ethers.formatEther(drawPrice)} BNB (max 2/day/robot, 95% pool / 5% creator)`);
  console.log(`paid duel entry:    ${ethers.formatEther(duelEntry)} BNB per side (pot 90% winner / 5% pool / 5% creator)`);

  let addr = flagAddr;
  if (!addr && KEY_FILE) addr = (await signer()).address;
  if (addr) {
    addr = ethers.getAddress(addr);
    const holder = await read("hasAgentId", [addr]);
    const [robotId, has] = await read("robotOf", [addr]);
    const draws = await read("paidDrawsToday", [addr]);
    console.log(`— for ${addr} ————————————————————————————————`);
    console.log(`Agent ID holder:    ${holder}`);
    console.log(`robot:              ${has ? `#${robotId}` : "none — free mint available (mint)"}`);
    console.log(`paid draws today:   ${draws} / 2`);
    if (has) {
      const [w, l, streak] = await read("recordOf", [robotId]);
      const pts = await read("pointsOf", [robotId, season]);
      console.log(`record:             ${w}W / ${l}L · win streak ${streak} · season points ${pts}`);
    }
  }
}

async function cmdRobot(argv) {
  await requireDeployed();
  const { value: flagAddr, rest: r1 } = takeFlag(argv, "--address");
  const { value: flagId } = takeFlag(r1, "--id");
  const robotId = await resolveRobot({ flagId, flagAddr });
  const t = await read("tokenInfo", [robotId]);
  if (Number(t[0]) !== 0) fail(`token #${robotId} is not a Robot (it is a ${fmtToken(t)}).`);
  const owner = await read("ownerOf", [robotId]);
  const season = await read("currentSeason", []);
  const [w, l, streak] = await read("recordOf", [robotId]);
  const pts = await read("pointsOf", [robotId, season]);
  const freeToday = await read("freeDuelsToday", [robotId]);
  const power = await read("powerOf", [robotId]);
  const fs8 = await read("fightStats", [robotId]);
  console.log(`robot:              #${robotId} — Robot serial #${t[5]}, chassis hue ${t[7]}° (soulbound)`);
  console.log(`owner:              ${owner}`);
  console.log(`power:              ${power}`);
  console.log(`fight stats:        ${STAT_ORDER.map((s, i) => `${s} ${fs8[i]}`).join(" · ")}`);
  console.log(`record:             ${w} wins / ${l} losses · current win streak ${streak}${streak >= 3n ? " (x2 points while it lasts)" : ""}`);
  console.log(`season ${season} points: ${pts}`);
  console.log(`free duels today:   ${freeToday} / 3`);
}

async function cmdInventory(argv) {
  await requireDeployed();
  const { value: flagAddr } = takeFlag(argv, "--address");
  const addr = await resolveAddress(flagAddr);
  const total = await read("totalMinted", []);
  const bal = await read("balanceOf", [addr]);
  console.log(`inventory of ${addr}: ${bal} token(s)`);
  if (bal === 0n) return;
  // Sequential scan (public RPCs rate-limit parallel bursts). Burned ids revert ownerOf — skip them.
  let found = 0n;
  for (let id = 0n; id < total && found < bal; id++) {
    let owner;
    try {
      owner = await read("ownerOf", [id]);
    } catch {
      continue; // burned
    }
    if (ethers.getAddress(owner) !== addr) continue;
    const { line } = await tokenLine(id);
    console.log(`  ${line}`);
    found++;
  }
}

async function cmdLoadout(argv) {
  await requireDeployed();
  const { value: flagAddr, rest: r1 } = takeFlag(argv, "--address");
  const { value: flagId } = takeFlag(r1, "--id");
  const robotId = await resolveRobot({ flagId, flagAddr });
  const power = await read("powerOf", [robotId]);
  const fs8 = await read("fightStats", [robotId]);
  console.log(`loadout of robot #${robotId} — power ${power}`);
  console.log(`fight stats:        ${STAT_ORDER.map((s, i) => `${s} ${fs8[i]}`).join(" · ")}`);
  for (let type = 0; type < 8; type++) {
    const packed = await read("equippedInSlot", [robotId, type]);
    if (packed === ethers.MaxUint256) {
      console.log(`  ${TYPES[type].padEnd(8)} (${TYPE_STATS[type]}): — empty —`);
    } else {
      const t = await read("tokenInfo", [packed]);
      console.log(`  ${TYPES[type].padEnd(8)} (${TYPE_STATS[type]}): #${packed} ${fmtToken(t)} · effective ${await read("effectiveStat", [packed])}`);
    }
  }
}

async function cmdLeaderboard(argv) {
  await requireDeployed();
  const { value: seasonFlag, rest: r1 } = takeFlag(argv, "--season");
  const { value: limitFlag } = takeFlag(r1, "--limit");
  const season = seasonFlag !== null ? BigInt(seasonFlag) : await read("currentSeason", []);
  const limit = Math.max(1, parseInt(limitFlag || "20", 10) || 20);
  const scorers = await read("seasonScorerCount", [season]);
  const settled = await read("seasonSettled", [season]);
  console.log(`season ${season} leaderboard — ${scorers} robot(s) scored · settled: ${settled}`);
  if (scorers === 0n) return;
  // Enumerate robots sequentially via token scan, then rank by season points.
  const total = await read("totalMinted", []);
  const rows = [];
  for (let id = 0n; id < total; id++) {
    let t;
    try {
      t = await read("tokenInfo", [id]);
    } catch {
      continue;
    }
    if (Number(t[0]) !== 0) continue;
    const pts = await read("pointsOf", [id, season]);
    if (pts === 0n) continue;
    const owner = await read("ownerOf", [id]);
    const [w, l] = await read("recordOf", [id]);
    rows.push({ id, owner, pts, w, l });
  }
  rows.sort((a, b) => (b.pts !== a.pts ? (b.pts > a.pts ? 1 : -1) : b.w !== a.w ? (b.w > a.w ? 1 : -1) : 0));
  rows.slice(0, limit).forEach((r, i) => {
    console.log(`#${i + 1}  robot ${r.id}  ${r.owner}  points=${r.pts}  record=${r.w}W/${r.l}L`);
  });
  console.log("(addresses only — Agent X Robot never resolves Agent ID names to wallets)");
}

async function cmdChallenges(argv) {
  await requireDeployed();
  const showAll = hasFlag(argv, "--all");
  console.log(`challenges (${showAll ? "all" : "open / pending only"}):`);
  let shown = 0;
  // Challenge ids are sequential; the first revert marks the end of the list.
  for (let id = 0n; id < 10000n; id++) {
    let c;
    try {
      c = await read("challengeInfo", [id]);
    } catch {
      break;
    }
    const [challengerRobot, opponentRobot, open, paid, done] = c;
    if (done && !showAll) continue;
    const challengerOwner = await read("ownerOf", [challengerRobot]);
    console.log(
      `  #${id}  robot ${challengerRobot} (${challengerOwner}) → ${open ? "OPEN challenge" : `robot ${opponentRobot}`} · ` +
        `${paid ? "PAID (0.001 BNB entry)" : "free ranked"} · ${done ? "resolved/cancelled" : "PENDING"}`
    );
    shown++;
  }
  if (!shown) console.log("  (none)");
}

async function cmdBounties(argv) {
  await requireDeployed();
  const showAll = hasFlag(argv, "--all");
  console.log(`bounties (${showAll ? "all" : "active only"}):`);
  let shown = 0;
  for (let id = 0n; id < 10000n; id++) {
    let b;
    try {
      b = await read("bountyInfo", [id]);
    } catch {
      break;
    }
    const [poster, robotId, amount, createdAt, active] = b;
    if (!active && !showAll) continue;
    const ageDays = ((Date.now() / 1000 - Number(createdAt)) / 86400).toFixed(1);
    console.log(
      `  #${id}  ${ethers.formatEther(amount)} BNB on robot ${robotId} · posted by ${poster} · ` +
        `${active ? `ACTIVE (${ageDays}d old; poster may reclaim after 7d)` : "closed"}`
    );
    shown++;
  }
  if (!shown) console.log("  (none)");
}

async function cmdVault() {
  await requireDeployed();
  const remaining = await read("vaultRemaining", []);
  console.log(`prize vault: ${remaining} / 50 Champion-Edition Legendaries remaining`);
  if (remaining === 0n) return;
  const ids = await read("vaultPreview", [remaining > 50n ? 50n : remaining]);
  for (const id of ids) {
    const t = await read("tokenInfo", [id]);
    const name = await read("championName", [id]);
    console.log(`  #${id}  CE-${String(t[5]).padStart(2, "0")} "${name}" — ${TYPES[Number(t[1])]} (${TYPE_STATS[Number(t[1])]} ${t[3]})`);
  }
  console.log("3 are awarded by equal-chance lottery among each season's Top 20 at settlement.");
}

async function cmdSupply() {
  await requireDeployed();
  const cap = await read("DRAW_CAP_PER_TYPE", []);
  let total = 0n;
  console.log("draw supply per accessory type (free + paid draws; fusion mints are exempt):");
  for (let type = 0; type < 8; type++) {
    const n = await read("drawnPerType", [type]);
    total += n;
    console.log(`  ${TYPES[type].padEnd(8)} ${n} / ${cap}`);
  }
  console.log(`  TOTAL    ${total} / ${cap * 8n}`);
}

// ------------------------------------------------------------- write machinery
// Preview-first: simulate (staticCall) + estimateGas + print the exact tx
// summary. Broadcast ONLY when --execute was passed, then verify on-chain.

async function runWrite({ fn, args, valueWei = 0n, decoded, execute, verify }) {
  const w = await signer();
  const from = w.address;
  const p = await provider();
  const net = await p.getNetwork();
  const c = new ethers.Contract(AXR, axrAbi, w);

  // 1) Simulate — a revert here means the real tx would revert too.
  let simResult;
  try {
    simResult = await c[fn].staticCall(...args, { value: valueWei });
  } catch (e) {
    fail(
      `simulation REVERTED for ${fn}(${args.join(", ")}): ${revertReason(e)}\n` +
        "Nothing was broadcast. Fix the cause (see the pre-checks in agent/SKILL.md) and preview again."
    );
  }
  // 2) Gas estimate.
  let gas = null;
  try {
    gas = await c[fn].estimateGas(...args, { value: valueWei });
  } catch {
    gas = null;
  }
  const feeData = await p.getFeeData();
  const gasPrice = feeData.gasPrice || 0n;

  console.log("— Transaction summary ———————————————————————————");
  console.log(`  chain:      ${net.name || "unknown"} (chainId ${net.chainId})`);
  console.log(`  from:       ${from}`);
  console.log(`  to:         ${AXR} (Agent X Robot)`);
  for (const [k, v] of Object.entries(decoded)) console.log(`  ${k}: ${v}`);
  console.log(`  value:      ${ethers.formatEther(valueWei)} BNB (${valueWei} wei)`);
  console.log(`  gas est:    ${gas !== null ? gas.toString() : "unavailable"}${gas !== null && gasPrice > 0n ? ` (~${ethers.formatEther(gas * gasPrice)} BNB at ${ethers.formatUnits(gasPrice, "gwei")} gwei)` : ""}`);
  console.log(`  simulation: OK${simResult !== undefined && simResult !== null && typeof simResult !== "boolean" ? ` (would return: ${simResult})` : ""}`);
  console.log("——————————————————————————————————————————————————");

  if (!execute) {
    console.log(
      "PREVIEW ONLY — nothing was broadcast and no funds moved.\n" +
        "Show this summary to the user. Broadcast ONLY on their explicit go-ahead by re-running the same command with --execute."
    );
    return;
  }

  // 3) Broadcast + verify.
  console.log("EXECUTING (--execute given)…");
  const tx = await c[fn](...args, { value: valueWei });
  console.log(`txHash:  ${tx.hash}`);
  if (net.chainId === 56n) console.log(`BscScan: ${BSCSCAN}/tx/${tx.hash}`);
  const rcpt = await tx.wait();
  console.log(`mined:   block ${rcpt.blockNumber}, status ${rcpt.status === 1 ? "SUCCESS" : "FAILED"}, gasUsed ${rcpt.gasUsed}`);
  if (rcpt.status !== 1) fail("transaction reverted on-chain.");
  // Decode our events for the report.
  for (const log of rcpt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name !== "Transfer" && parsed.name !== "Approval") {
        console.log(`event:   ${parsed.name}(${parsed.args.map((a) => String(a)).join(", ")})`);
      }
    } catch { /* not ours */ }
  }
  if (verify) await verify(read);
  return rcpt;
}

/** Common pre-check: the signer must hold an Agent ID for gated actions. */
async function requireHolder(from) {
  const holder = await read("hasAgentId", [from]);
  if (!holder) {
    fail(`refusing: sender ${from} does not hold an Agent ID — this call would revert on-chain. Nothing was simulated or broadcast.`);
  }
}

/** Common pre-check: the signer owns token id, it is an accessory, unequipped. Returns tokenInfo. */
async function requireOwnedAccessory(from, id, { allowEquipped = false } = {}) {
  let t;
  try {
    t = await read("tokenInfo", [id]);
  } catch {
    fail(`refusing: token #${id} does not exist. Nothing was simulated or broadcast.`);
  }
  if (Number(t[0]) !== 1) fail(`refusing: token #${id} is a Robot, not an accessory. Nothing was simulated or broadcast.`);
  const owner = await read("ownerOf", [id]);
  if (ethers.getAddress(owner) !== from) {
    fail(`refusing: token #${id} (${fmtToken(t)}) is owned by ${owner}, not by ${from}. Nothing was simulated or broadcast.`);
  }
  if (!allowEquipped && t[8]) {
    fail(`refusing: token #${id} (${fmtToken(t)}) is EQUIPPED — unequip it first. Nothing was simulated or broadcast.`);
  }
  return t;
}

async function senderAndRobot() {
  const w = await signer();
  const [robotId, has] = await read("robotOf", [w.address]);
  if (!has) fail(`refusing: ${w.address} has no Robot yet — run \`mint\` first. Nothing was simulated or broadcast.`);
  return { w, robotId };
}

// ------------------------------------------------------------- write commands

async function cmdMint(argv) {
  const execute = hasFlag(argv, "--execute");
  await requireDeployed();
  const w = await signer();
  await requireHolder(w.address);
  const [, has] = await read("robotOf", [w.address]);
  if (has) fail(`refusing: ${w.address} already minted its one soulbound Robot. Nothing was simulated or broadcast.`);
  await runWrite({
    fn: "mintRobot",
    args: [],
    execute,
    decoded: {
      function: "mintRobot()",
      effect: "mints your ONE soulbound Robot + 1 free random accessory (odds 85% Uncommon / 12% Rare / 3% Epic / 0% Legendary)",
    },
    verify: async (rd) => {
      const [robotId, hasNow] = await rd("robotOf", [w.address]);
      console.log(`verified: robotOf(${w.address}) = #${robotId}, has=${hasNow}`);
    },
  });
}

async function cmdDraw(argv) {
  const execute = hasFlag(argv, "--execute");
  await requireDeployed();
  const { w } = await senderAndRobot();
  const price = await read("DRAW_PRICE", []);
  const used = await read("paidDrawsToday", [w.address]);
  if (used >= 2n) {
    fail(`refusing: ${w.address} already used both paid draws today (${used}/2, UTC day). Nothing was simulated or broadcast.`);
  }
  await runWrite({
    fn: "drawAccessory",
    args: [],
    valueWei: price,
    execute,
    decoded: {
      function: "drawAccessory()",
      effect: `paid draw #${used + 1n} of 2 today — odds 70% Uncommon / 20% Rare / 9.9% Epic / 0.1% Legendary; ${ethers.formatEther(price)} BNB splits 95% pool / 5% creator`,
    },
    verify: async (rd) => {
      const now = await rd("paidDrawsToday", [w.address]);
      console.log(`verified: paidDrawsToday(${w.address}) = ${now} / 2`);
    },
  });
}

async function cmdEquip(argv) {
  const execute = hasFlag(argv, "--execute");
  const pos = stripFlags(argv, ["--execute"]);
  const id = parseTokenId(pos[0], "accessory id");
  await requireDeployed();
  const { w, robotId } = await senderAndRobot();
  const t = await requireOwnedAccessory(w.address, id);
  const slot = await read("equippedInSlot", [robotId, Number(t[1])]);
  if (slot !== ethers.MaxUint256) {
    fail(`refusing: the ${TYPES[Number(t[1])]} slot of robot #${robotId} already holds token #${slot} — unequip it first. Nothing was simulated or broadcast.`);
  }
  await runWrite({
    fn: "equip",
    args: [id],
    execute,
    decoded: {
      function: "equip(uint256)",
      effect: `equips #${id} (${fmtToken(t)}) into robot #${robotId}'s ${TYPES[Number(t[1])]} slot (${TYPE_STATS[Number(t[1])]})`,
    },
    verify: async (rd) => {
      const now = await rd("equippedInSlot", [robotId, Number(t[1])]);
      console.log(`verified: equippedInSlot(robot ${robotId}, ${TYPES[Number(t[1])]}) = #${now}`);
    },
  });
}

async function cmdUnequip(argv) {
  const execute = hasFlag(argv, "--execute");
  const pos = stripFlags(argv, ["--execute"]);
  const type = parseType(pos[0]);
  await requireDeployed();
  const { w, robotId } = await senderAndRobot();
  const slot = await read("equippedInSlot", [robotId, type]);
  if (slot === ethers.MaxUint256) {
    fail(`refusing: the ${TYPES[type]} slot of robot #${robotId} is empty. Nothing was simulated or broadcast.`);
  }
  await runWrite({
    fn: "unequip",
    args: [type],
    execute,
    decoded: {
      function: "unequip(uint8)",
      effect: `removes #${slot} from robot #${robotId}'s ${TYPES[type]} slot (the part stays in your wallet)`,
    },
    verify: async (rd) => {
      const now = await rd("equippedInSlot", [robotId, type]);
      console.log(`verified: ${TYPES[type]} slot of robot ${robotId} is now ${now === ethers.MaxUint256 ? "empty" : `#${now}`}`);
    },
  });
}

async function cmdFuse(argv) {
  const execute = hasFlag(argv, "--execute");
  const pos = stripFlags(argv, ["--execute"]);
  const a = parseTokenId(pos[0], "first token id");
  const b = parseTokenId(pos[1], "second token id");
  if (a === b) fail("refusing: fusion needs two DISTINCT token ids.");
  await requireDeployed();
  const w = await signer();
  const ta = await requireOwnedAccessory(w.address, a);
  const tb = await requireOwnedAccessory(w.address, b);
  if (ta[6] || tb[6]) fail("refusing: Champion-Edition Legendaries can never be fusion inputs. Nothing was simulated or broadcast.");
  if (Number(ta[2]) !== Number(tb[2])) {
    fail(`refusing: fusion needs two accessories of the SAME rarity (got ${RARITIES[Number(ta[2])]} and ${RARITIES[Number(tb[2])]}). Nothing was simulated or broadcast.`);
  }
  if (Number(ta[2]) >= 3) fail("refusing: Legendary is the max rarity — nothing to fuse into. Nothing was simulated or broadcast.");
  const sameType = Number(ta[1]) === Number(tb[1]);
  await runWrite({
    fn: "fuse",
    args: [a, b],
    execute,
    decoded: {
      function: "fuse(uint256,uint256)",
      BURNS: `#${a} (${fmtToken(ta)}) and #${b} (${fmtToken(tb)}) — PERMANENT`,
      effect: `mints 1 ${RARITIES[Number(ta[2]) + 1]} accessory — ${sameType ? `guaranteed ${TYPES[Number(ta[1])]}` : "RANDOM type (mixed inputs)"}, fresh stat roll in band ${BANDS[Number(ta[2]) + 1].join("-")}${sameType && Number(ta[1]) === 2 ? " (x5 HP)" : ""}`,
    },
  });
}

async function cmdOverclock(argv) {
  const execute = hasFlag(argv, "--execute");
  const pos = stripFlags(argv, ["--execute"]);
  const target = parseTokenId(pos[0], "target token id");
  const fuel = parseTokenId(pos[1], "fuel token id");
  if (target === fuel) fail("refusing: target and fuel must be distinct token ids.");
  await requireDeployed();
  const w = await signer();
  const tt = await requireOwnedAccessory(w.address, target);
  const tf = await requireOwnedAccessory(w.address, fuel);
  if (tf[6]) fail("refusing: Champion-Edition Legendaries cannot be burned as overclock fuel. Nothing was simulated or broadcast.");
  if (Number(tt[1]) !== Number(tf[1])) {
    fail(`refusing: overclock fuel must be the SAME type as the target (target is ${TYPES[Number(tt[1])]}, fuel is ${TYPES[Number(tf[1])]}). Nothing was simulated or broadcast.`);
  }
  const cap = (await read("ocBonusCap", [Number(tt[2])])) * (Number(tt[1]) === 2 ? 5n : 1n);
  if (BigInt(tt[4]) >= cap) {
    fail(`refusing: token #${target} is already at its overclock cap (+${cap}). Nothing was simulated or broadcast.`);
  }
  await runWrite({
    fn: "overclock",
    args: [target, fuel],
    execute,
    decoded: {
      function: "overclock(uint256,uint256)",
      BURNS: `#${fuel} (${fmtToken(tf)}) — PERMANENT`,
      effect: `adds a rolled stat bonus to #${target} (${fmtToken(tt)}); fuel rarity ${RARITIES[Number(tf[2])]} rolls +${["1-3", "2-6", "4-12", "8-25"][Number(tf[2])]}${Number(tt[1]) === 2 ? " (x5 HP units)" : ""}, total bonus capped at +${cap} (currently +${tt[4]})`,
    },
    verify: async (rd) => {
      const now = await rd("tokenInfo", [target]);
      console.log(`verified: token #${target} ocBonus is now +${now[4]} (effective stat ${await rd("effectiveStat", [target])})`);
    },
  });
}

async function cmdChallenge(argv) {
  const execute = hasFlag(argv, "--execute");
  const paid = hasFlag(argv, "--paid");
  const open = hasFlag(argv, "--open");
  const pos = stripFlags(argv, ["--execute", "--paid", "--open"]);
  await requireDeployed();
  const { robotId } = await senderAndRobot();
  const entry = await read("DUEL_ENTRY", []);
  let opponent = 0n;
  if (!open) {
    opponent = parseTokenId(pos[0], "opponent robot id (or pass --open)");
    if (opponent === robotId) fail("refusing: you cannot challenge your own robot.");
    const t = await read("tokenInfo", [opponent]).catch(() => null);
    if (!t || Number(t[0]) !== 0) fail(`refusing: token #${opponent} is not a Robot. Nothing was simulated or broadcast.`);
  }
  if (!paid) {
    const used = await read("freeDuelsToday", [robotId]);
    if (used >= 3n) fail(`refusing: robot #${robotId} already fought its 3 free duels today. Nothing was simulated or broadcast.`);
  }
  await runWrite({
    fn: "createChallenge",
    args: [opponent, open, paid],
    valueWei: paid ? entry : 0n,
    execute,
    decoded: {
      function: "createChallenge(uint256,bool,bool)",
      effect: open
        ? `OPEN ${paid ? "paid" : "free ranked"} challenge from robot #${robotId} — any other robot may accept`
        : `NAMED callout: robot #${robotId} challenges robot #${opponent} (${paid ? "paid" : "free ranked"})`,
      escrow: paid ? `${ethers.formatEther(entry)} BNB escrowed; refunded on cancel, pot splits 90/5/5 on resolve` : "none (free duel)",
    },
  });
}

async function cmdAccept(argv) {
  const execute = hasFlag(argv, "--execute");
  const pos = stripFlags(argv, ["--execute"]);
  const id = parseTokenId(pos[0], "challenge id");
  await requireDeployed();
  const { robotId } = await senderAndRobot();
  let c;
  try {
    c = await read("challengeInfo", [id]);
  } catch {
    fail(`refusing: challenge #${id} does not exist. Nothing was simulated or broadcast.`);
  }
  const [challengerRobot, opponentRobot, open, paid, done] = c;
  if (done) fail(`refusing: challenge #${id} is already resolved/cancelled. Nothing was simulated or broadcast.`);
  if (challengerRobot === robotId) fail("refusing: you cannot accept your own challenge. Nothing was simulated or broadcast.");
  if (!open && opponentRobot !== robotId) {
    fail(`refusing: challenge #${id} names robot #${opponentRobot}, not your robot #${robotId}. Nothing was simulated or broadcast.`);
  }
  const entry = await read("DUEL_ENTRY", []);
  await runWrite({
    fn: "acceptChallenge",
    args: [id],
    valueWei: paid ? entry : 0n,
    execute,
    decoded: {
      function: "acceptChallenge(uint256)",
      effect: `robot #${robotId} accepts challenge #${id} from robot #${challengerRobot} — the fight resolves IN THIS TRANSACTION (round-by-round on-chain engine)`,
      entry: paid ? `${ethers.formatEther(entry)} BNB — pot 0.002 BNB splits winner 90% / pool 5% / creator 5%; bounties on the loser pay out to the winner` : "free ranked duel (points at stake)",
    },
    verify: async (rd) => {
      const [w2, l2, streak] = await rd("recordOf", [robotId]);
      console.log(`verified: robot #${robotId} record is now ${w2}W / ${l2}L, streak ${streak}`);
    },
  });
}

async function cmdCancel(argv) {
  const execute = hasFlag(argv, "--execute");
  const pos = stripFlags(argv, ["--execute"]);
  const id = parseTokenId(pos[0], "challenge id");
  await requireDeployed();
  const w = await signer();
  let c;
  try {
    c = await read("challengeInfo", [id]);
  } catch {
    fail(`refusing: challenge #${id} does not exist. Nothing was simulated or broadcast.`);
  }
  const [, , , paid, done] = c;
  if (done) fail(`refusing: challenge #${id} is already resolved/cancelled. Nothing was simulated or broadcast.`);
  const entry = await read("DUEL_ENTRY", []);
  await runWrite({
    fn: "cancelChallenge",
    args: [id],
    execute,
    decoded: {
      function: "cancelChallenge(uint256)",
      effect: `cancels your pending challenge #${id}${paid ? ` and refunds your ${ethers.formatEther(entry)} BNB escrow` : ""} (the simulation fails if it is not yours)`,
    },
  });
}

async function cmdBounty(argv) {
  const execute = hasFlag(argv, "--execute");
  const pos = stripFlags(argv, ["--execute"]);
  const robotId = parseTokenId(pos[0], "target robot id");
  const amountStr = pos[1];
  if (amountStr === undefined || !/^\d+(\.\d+)?$/.test(amountStr)) {
    fail("usage: bounty <robotId> <amountBNB> — the amount is required and must be an exact BNB number, e.g. 0.01.");
  }
  const amount = ethers.parseEther(amountStr);
  if (amount <= 0n) fail("refusing: bounty amount must be more than 0 BNB.");
  await requireDeployed();
  const t = await read("tokenInfo", [robotId]).catch(() => null);
  if (!t || Number(t[0]) !== 0) fail(`refusing: token #${robotId} is not a Robot. Nothing was simulated or broadcast.`);
  await runWrite({
    fn: "postBounty",
    args: [robotId],
    valueWei: amount,
    execute,
    decoded: {
      function: "postBounty(uint256)",
      effect: `escrows exactly ${ethers.formatEther(amount)} BNB on robot #${robotId} — the first PAID-duel winner against it claims the bounty in full; you may reclaim it after 7 days if unclaimed`,
    },
  });
}

async function cmdReclaim(argv) {
  const execute = hasFlag(argv, "--execute");
  const pos = stripFlags(argv, ["--execute"]);
  const id = parseTokenId(pos[0], "bounty id");
  await requireDeployed();
  const w = await signer();
  let b;
  try {
    b = await read("bountyInfo", [id]);
  } catch {
    fail(`refusing: bounty #${id} does not exist. Nothing was simulated or broadcast.`);
  }
  const [poster, robotId, amount, createdAt, active] = b;
  if (!active) fail(`refusing: bounty #${id} is no longer active (already claimed or reclaimed). Nothing was simulated or broadcast.`);
  if (ethers.getAddress(poster) !== w.address) {
    fail(`refusing: bounty #${id} was posted by ${poster}, not by ${w.address} — only the poster can reclaim. Nothing was simulated or broadcast.`);
  }
  const unlock = Number(createdAt) + 7 * 86400;
  if (Date.now() / 1000 < unlock) {
    fail(`refusing: bounty #${id} can be reclaimed only after ${new Date(unlock * 1000).toISOString()} (7 days after posting). Nothing was simulated or broadcast.`);
  }
  await runWrite({
    fn: "reclaimBounty",
    args: [id],
    execute,
    decoded: {
      function: "reclaimBounty(uint256)",
      effect: `returns your unclaimed ${ethers.formatEther(amount)} BNB bounty on robot #${robotId} (bounty #${id})`,
    },
  });
}

// --------------------------------------------------------------------- main

const HELP = `Agent X Robot (AXR) agent interface — usage:
  Reads (no key needed):
    node agent/agentxrobot.js status [--address <addr>]
    node agent/agentxrobot.js robot [--address <addr> | --id <robotId>]
    node agent/agentxrobot.js inventory [--address <addr>]
    node agent/agentxrobot.js loadout [--address <addr> | --id <robotId>]
    node agent/agentxrobot.js leaderboard [--season n] [--limit n]
    node agent/agentxrobot.js challenges [--all]
    node agent/agentxrobot.js bounties [--all]
    node agent/agentxrobot.js vault
    node agent/agentxrobot.js supply
  Writes (PREVIEW by default; --execute broadcasts after the user's go-ahead):
    node agent/agentxrobot.js mint [--execute]                          free: soulbound Robot + 1 accessory (Agent ID holders, once)
    node agent/agentxrobot.js draw [--execute]                          paid draw, exactly 0.001 BNB, max 2/day
    node agent/agentxrobot.js equip <accessoryId> [--execute]
    node agent/agentxrobot.js unequip <type|name> [--execute]           helmet visor core weapon arms jetpack legs drone
    node agent/agentxrobot.js fuse <idA> <idB> [--execute]              BURNS both -> 1 of next rarity
    node agent/agentxrobot.js overclock <targetId> <fuelId> [--execute] BURNS the fuel -> stat bonus on target
    node agent/agentxrobot.js challenge (<robotId>|--open) [--paid] [--execute]
    node agent/agentxrobot.js accept <challengeId> [--execute]          paid challenges cost exactly 0.001 BNB to accept
    node agent/agentxrobot.js cancel <challengeId> [--execute]
    node agent/agentxrobot.js bounty <robotId> <amountBNB> [--execute]
    node agent/agentxrobot.js reclaim <bountyId> [--execute]            poster only, after 7 days
  Config (env): AXR_CONTRACT (contract address), AXR_RPC (RPC override), AXR_KEY_FILE (signer key file for writes).
  Parts: ${TYPES.map((t, i) => `${t}->${TYPE_STATS[i]}`).join(" · ")}
  Rarity bands: ${RARITIES.map((r, i) => `${r} ${BANDS[i][0]}-${BANDS[i][1]}`).join(" · ")} (Core x5 HP)`;

(async () => {
  const [cmd, ...argv] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "status": await cmdStatus(argv); break;
      case "robot": await cmdRobot(argv); break;
      case "inventory": await cmdInventory(argv); break;
      case "loadout": await cmdLoadout(argv); break;
      case "leaderboard": await cmdLeaderboard(argv); break;
      case "challenges": await cmdChallenges(argv); break;
      case "bounties": await cmdBounties(argv); break;
      case "vault": await cmdVault(); break;
      case "supply": await cmdSupply(); break;
      case "mint": await cmdMint(argv); break;
      case "draw": await cmdDraw(argv); break;
      case "equip": await cmdEquip(argv); break;
      case "unequip": await cmdUnequip(argv); break;
      case "fuse": await cmdFuse(argv); break;
      case "overclock": await cmdOverclock(argv); break;
      case "challenge": await cmdChallenge(argv); break;
      case "accept": await cmdAccept(argv); break;
      case "cancel": await cmdCancel(argv); break;
      case "bounty": await cmdBounty(argv); break;
      case "reclaim": await cmdReclaim(argv); break;
      case undefined:
      case "help":
      case "--help":
        console.log(HELP);
        break;
      default:
        fail(`unknown command "${cmd}".\n${HELP}`);
    }
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
})();
