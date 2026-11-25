#!/usr/bin/env node
/*
 * Agent X Robot — hosted metadata + per-token image generator.
 *
 * WHY: the on-chain tokenURI returns base64 JSON with NO image field, so
 * marketplaces (Element) fall back to the collection logo for every item.
 * This script renders a real PNG per token and a hosted metadata JSON per
 * token, so the owner can point the contract at them with setBaseURI.
 *
 * WHAT IT DOES (all reads are sequential, rotated BSC RPCs, browser UA):
 *   1. Reads totalMinted() live, then tokenInfo(id) for every token id.
 *   2. Renders frontend/public/art/tokens/<id>.png:
 *        Robot     -> composed loadout (art/compose.js) on dark #0d1117
 *        Accessory -> part SVG over dark card + ghosted base (per art/README)
 *        Champion  -> same as its type + gold frame + "CHAMPION EDITION"
 *                     banner with its CE serial + unique name.
 *   3. Writes frontend/public/metadata/<id>.json with the SAME name /
 *      description / traits as the on-chain tokenURI, plus an "image" field
 *      (https://agent-x-robot.vercel.app/art/tokens/<id>.png), a "Name"
 *      trait for Champion-Edition tokens and an "Equipped" summary for
 *      robots. Names/descriptions are cross-checked against the decoded
 *      on-chain tokenURI for every token; mismatches are logged.
 *   4. The contract's tokenURI returns baseURI + <id> (no .json suffix),
 *      so frontend/vercel.json rewrites /metadata/:id -> /metadata/:id.json
 *      (served as application/json).
 *
 * IDEMPOTENT / RE-RUNNABLE: scripts/metadata-state.json stores a hash of
 * each token's on-chain inputs (tokenInfo + championName + equipped loadout).
 * Tokens whose hash matches and whose outputs exist are skipped. New mints
 * and changed loadouts (equip/unequip/fusion/overclock) are regenerated.
 * Burned tokens (fusion victims) have their outputs removed.
 *
 * USAGE (from ~/workspace/agent-x-robot):
 *   NODE_PATH=~/workspace/ramenforge/node_modules node scripts/generate-metadata.js
 *   NODE_PATH=~/workspace/ramenforge/node_modules node scripts/generate-metadata.js --force
 *   NODE_PATH=~/workspace/ramenforge/node_modules node scripts/generate-metadata.js --only 50,51,52
 * Re-run after new mints / loadout changes, then push the new files and
 * re-deploy the site. No setBaseURI call is needed on re-runs (base URI is
 * stable); only the FIRST run needs the owner to set it once.
 *
 * DO NOT run with a wallet/key — this script only reads the chain.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT = '0xBdd7Db43BdDB4CbE288c31A367a187B2Cae1138A';
const SITE = 'https://agent-x-robot.vercel.app';
const DESC =
  "Agent X Robot on BNB Chain: your Agent ID's fighter. Draw parts, fuse and overclock them, equip your robot and duel other agents. The owner cannot withdraw the pool or change the rules.";

const RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc-dataseed4.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const TYPE_NAMES = ['Helmet', 'Visor', 'Core', 'Weapon', 'Arms', 'Jetpack', 'Legs', 'Drone'];
const TYPE_SLUGS = ['helmet', 'visor', 'core', 'weapon', 'arms', 'jetpack', 'legs', 'drone'];
const STAT_NAMES = ['DEF', 'ACC', 'HP', 'ATK', 'CRIT', 'EVA', 'SPD', 'LUCK'];
const RARITY_NAMES = ['Uncommon', 'Rare', 'Epic', 'Legendary'];
const RARITY_SLUGS = ['uncommon', 'rare', 'epic', 'legendary'];

const TOKENS_DIR = path.join(ROOT, 'frontend', 'public', 'art', 'tokens');
const META_DIR = path.join(ROOT, 'frontend', 'public', 'metadata');
const STATE_FILE = path.join(__dirname, 'metadata-state.json');
const TMP_DIR = '/tmp/axr-meta';

// ---- RPC (raw eth_call, sequential, rotate endpoints on failure) ----
const artifact = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'artifacts', 'contracts', 'AgentXRobot.sol', 'AgentXRobot.json'), 'utf8')
);
const iface = new ethers.Interface(artifact.abi);

async function ethCall(data, attempt = 0) {
  const rpc = RPCS[attempt % RPCS.length];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: CONTRACT, data }, 'latest'], id: 1 }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    if (j.error) throw new Error(`rpc error ${j.error.code}: ${j.error.message} ${j.error.data || ''}`);
    if (!j.result) throw new Error('empty rpc result');
    return j.result;
  } catch (e) {
    if (attempt >= RPCS.length * 2 - 1) throw e;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    return ethCall(data, attempt + 1);
  } finally {
    clearTimeout(t);
  }
}

async function call(fn, args = []) {
  const data = iface.encodeFunctionData(fn, args);
  const raw = await ethCall(data);
  const out = iface.decodeFunctionResult(fn, raw);
  return out.length === 1 ? out[0] : out;
}

function isNotExistError(e) {
  return /token does not exist|does not exist/i.test(String(e && e.message ? e.message : e));
}

// ---- SVG helpers ----
function innerOf(svg) {
  const m = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!m) throw new Error('not an svg file');
  return m[1].replace(/<!--[\s\S]*?-->/g, '').trim();
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function svgDoc(inner, bg = '#0d1117') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000"><rect width="1000" height="1000" fill="${bg}"/>${inner}</svg>`;
}
function renderPng(svgPath, pngPath) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', svgPath, '-vf', 'scale=1000:1000', pngPath]);
}

const { compose } = require(path.join(ROOT, 'art', 'compose.js'));
const ART = path.join(ROOT, 'art');
const baseInner = innerOf(fs.readFileSync(path.join(ART, 'base', 'robot-base.svg'), 'utf8'));
function partInner(typeSlug, raritySlug) {
  return innerOf(fs.readFileSync(path.join(ART, 'parts', `${typeSlug}-${raritySlug}.svg`), 'utf8'));
}
function pad2(v) {
  return v < 10 ? `0${v}` : `${v}`;
}

// ---- Per-token builders ----
function robotImageSvg(equipped) {
  // equipped: [{type, rarity}] currently on the robot
  const chosen = {};
  for (const p of equipped) chosen[TYPE_SLUGS[p.type]] = RARITY_SLUGS[p.rarity];
  const composed = compose(chosen);
  return svgDoc(innerOf(composed));
}

function accessoryImageSvg(info, ceName) {
  const typeSlug = TYPE_SLUGS[info.accType];
  const raritySlug = RARITY_SLUGS[info.rarity];
  const label = info.champion
    ? `CE-${pad2(info.serial)} · ${ceName}`
    : `AXR ${TYPE_NAMES[info.accType]} — ${RARITY_NAMES[info.rarity]} · ${STAT_NAMES[info.accType]} ${info.stat}${info.ocBonus ? ` (+${info.ocBonus})` : ''}`;
  // Art is scaled to 0.9 (900px) so the bottom ~100px stays clear for labels:
  // part overlays run to y=950 (legs) and helmets start at y=52, so a full-
  // bleed label or a top banner would overlap the art itself.
  let inner = `<g transform="translate(50,0) scale(0.9)"><g opacity="0.12">${baseInner}</g>\n${partInner(typeSlug, raritySlug)}</g>`;
  if (info.champion) {
    inner += `
<rect x="14" y="14" width="972" height="972" fill="none" stroke="#e8a90c" stroke-width="10"/>
<text x="500" y="930" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="bold" fill="#ffd94d">★ CHAMPION EDITION ★</text>
<text x="500" y="972" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="bold" fill="#ffd94d">${esc(`CE-${pad2(info.serial)} · ${ceName}`)}</text>`;
  } else {
    inner += `
<text x="500" y="955" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="bold" fill="#e8eef5">${esc(label)}</text>`;
  }
  return svgDoc(inner);
}

function buildMetadata(id, info, ceName, equippedNames) {
  // Mirrors the on-chain _tokenJSON exactly for name/description/traits.
  const image = `${SITE}/art/tokens/${id}.png`;
  if (info.kind === 0) {
    return {
      name: `Agent X Robot #${info.serial}`,
      description: DESC,
      image,
      external_url: `${SITE}/`,
      attributes: [
        { trait_type: 'Kind', value: 'Robot' },
        { trait_type: 'Chassis', value: Number(info.chassis) },
        { trait_type: 'Equipped', value: equippedNames.length ? equippedNames.join(', ') : 'None' },
      ],
    };
  }
  const attrs = [
    { trait_type: 'Kind', value: 'Accessory' },
    { trait_type: 'Type', value: TYPE_NAMES[info.accType] },
    { trait_type: 'Stat', value: STAT_NAMES[info.accType] },
    { trait_type: 'Rarity', value: RARITY_NAMES[info.rarity] },
    { trait_type: 'Stat Value', value: Number(info.stat) },
    { trait_type: 'Overclock', value: Number(info.ocBonus) },
    { trait_type: 'Champion Edition', value: info.champion ? 'Yes' : 'No' },
  ];
  if (info.champion) {
    attrs.push({ trait_type: 'Name', value: ceName });
    attrs.push({ trait_type: 'Serial', value: `CE-${pad2(info.serial)}` });
  }
  const name = info.champion
    ? `CE-${pad2(info.serial)} ${ceName} (${TYPE_NAMES[info.accType]})`
    : `AXR ${TYPE_NAMES[info.accType]} - ${RARITY_NAMES[info.rarity]}`;
  return { name, description: DESC, image, external_url: `${SITE}/`, attributes: attrs };
}

function hashInputs(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

// ---- Main ----
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 && args[onlyIdx + 1]
    ? args[onlyIdx + 1].split(',').map((s) => Number(s.trim()))
    : null;

  fs.mkdirSync(TOKENS_DIR, { recursive: true });
  fs.mkdirSync(META_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  let state = { generatedAt: null, totalMinted: 0, tokens: {} };
  if (fs.existsSync(STATE_FILE)) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* start fresh */ }
  }

  const totalMinted = Number(await call('totalMinted'));
  console.log(`totalMinted (live): ${totalMinted}`);

  const ids = [];
  for (let i = 0; i < totalMinted; i++) ids.push(i);
  const targets = only ? ids.filter((i) => only.includes(i)) : ids;

  let generated = 0, skipped = 0, burned = 0, mismatches = 0;
  for (const id of targets) {
    let infoRaw;
    try {
      infoRaw = await call('tokenInfo', [id]);
    } catch (e) {
      if (isNotExistError(e)) {
        // Burned (fusion victim) — remove stale outputs.
        for (const f of [path.join(TOKENS_DIR, `${id}.png`), path.join(META_DIR, `${id}.json`)]) {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }
        delete state.tokens[id];
        burned++;
        console.log(`#${id}: burned — outputs removed`);
        continue;
      }
      throw e;
    }
    const info = {
      kind: Number(infoRaw[0]), accType: Number(infoRaw[1]), rarity: Number(infoRaw[2]),
      stat: Number(infoRaw[3]), ocBonus: Number(infoRaw[4]), serial: Number(infoRaw[5]),
      champion: Boolean(infoRaw[6]), chassis: Number(infoRaw[7]), equipped: Boolean(infoRaw[8]),
    };

    let ceName = '';
    if (info.champion) ceName = await call('championName', [id]);

    // Equipped loadout for robots.
    let equipped = [];
    let equippedNames = [];
    if (info.kind === 0) {
      for (let t = 0; t < 8; t++) {
        const accId = await call('equippedInSlot', [id, t]);
        if (accId === ethers.MaxUint256) continue;
        const acc = await call('tokenInfo', [Number(accId)]);
        equipped.push({ type: Number(acc[1]), rarity: Number(acc[2]) });
        equippedNames.push(`${TYPE_NAMES[Number(acc[1])]} (${RARITY_NAMES[Number(acc[2])]})`);
      }
    }

    const hash = hashInputs({ info, ceName, equipped });
    const pngPath = path.join(TOKENS_DIR, `${id}.png`);
    const jsonPath = path.join(META_DIR, `${id}.json`);
    if (!force && state.tokens[id] === hash && fs.existsSync(pngPath) && fs.existsSync(jsonPath)) {
      skipped++;
      continue;
    }

    // Cross-check name/description against the decoded on-chain tokenURI.
    try {
      const uri = await call('tokenURI', [id]);
      const b64 = uri.split('base64,')[1];
      if (b64) {
        const onchain = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        const mine = buildMetadata(id, info, ceName, equippedNames);
        if (onchain.name !== mine.name || onchain.description !== mine.description) {
          mismatches++;
          console.log(`#${id}: NAME/DESC MISMATCH vs on-chain: on-chain=${JSON.stringify(onchain.name)} mine=${JSON.stringify(mine.name)}`);
        }
      }
    } catch (e) {
      console.log(`#${id}: tokenURI check skipped (${e.message.slice(0, 80)})`);
    }

    // Render image.
    const svg = info.kind === 0 ? robotImageSvg(equipped) : accessoryImageSvg(info, ceName);
    const tmpSvg = path.join(TMP_DIR, `${id}.svg`);
    fs.writeFileSync(tmpSvg, svg);
    renderPng(tmpSvg, pngPath);

    // Write metadata.
    const meta = buildMetadata(id, info, ceName, equippedNames);
    fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2) + '\n');

    state.tokens[id] = hash;
    generated++;
    const label = info.kind === 0
      ? `Robot #${info.serial} (${equippedNames.length} equipped)`
      : info.champion ? `CE-${pad2(info.serial)} ${ceName}` : `${meta.name} · ${STAT_NAMES[info.accType]} ${info.stat}`;
    console.log(`#${id}: generated ${label}`);
  }

  state.generatedAt = new Date().toISOString();
  state.totalMinted = totalMinted;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  console.log(`\nDone. totalMinted=${totalMinted} generated=${generated} skipped=${skipped} burned=${burned} nameMismatches=${mismatches}`);
  console.log(`Images: frontend/public/art/tokens/ | Metadata: frontend/public/metadata/`);
  console.log(`Next: build frontend, push new files, deploy site. Owner then sets baseURI to ${SITE}/metadata/ (once).`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
