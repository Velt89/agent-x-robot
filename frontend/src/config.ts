import { bsc } from "viem/chains";

// BNB Chain mainnet
export const CHAIN = bsc; // id 56

// SPACE ID Agent ID registry (ERC-721, non-transferable) — verified live.
// balanceOf(address) > 0 means the address holds an Agent ID.
export const AGENT_ID_REGISTRY = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F" as const;

// ---------------------------------------------------------------------------
// DEPLOYMENT — flip these three when the contract goes live.
// Until AXR_DEPLOYED is true the site renders in "deploying soon" mode:
// hero + published rules/odds show normally, every on-chain read is skipped
// and every action button stays disabled.
// ---------------------------------------------------------------------------
export const AXR_ADDRESS = "0xBdd7Db43BdDB4CbE288c31A367a187B2Cae1138A" as const;
export const AXR_DEPLOYED = true;
// Block the AgentXRobot contract was deployed in (for event scans).
export const AXR_START_BLOCK = 135576491n;

// Dedicated creator/owner EOA (marketplace identity only — zero game power).
export const CREATOR_ADDRESS = "0x4DDdCAFc1f997528bC12f4FDf6d47a08e455a7aB" as const;

// The 8 accessory types, in contract order (accType 0-7), each owning one stat.
export const PART_TYPES = [
  { type: 0, name: "Helmet", slug: "helmet", stat: "DEF" },
  { type: 1, name: "Visor", slug: "visor", stat: "ACC" },
  { type: 2, name: "Core", slug: "core", stat: "HP" },
  { type: 3, name: "Weapon", slug: "weapon", stat: "ATK" },
  { type: 4, name: "Arms", slug: "arms", stat: "CRIT" },
  { type: 5, name: "Jetpack", slug: "jetpack", stat: "EVA" },
  { type: 6, name: "Legs", slug: "legs", stat: "SPD" },
  { type: 7, name: "Drone", slug: "drone", stat: "LUCK" },
] as const;

// Rarities 0-3. Stat bands mirror the contract (Core/HP rolls are x5).
export const RARITIES = [
  { rarity: 0, name: "Uncommon", slug: "uncommon", band: "1–10", min: 1, max: 10 },
  { rarity: 1, name: "Rare", slug: "rare", band: "11–25", min: 11, max: 25 },
  { rarity: 2, name: "Epic", slug: "epic", band: "26–50", min: 26, max: 50 },
  { rarity: 3, name: "Legendary", slug: "legendary", band: "51–100", min: 51, max: 100 },
] as const;

// Published draw odds (percent). Free = the accessory bundled with the
// one-time free Robot mint. Paid = drawAccessory() at 0.001 BNB.
export const FREE_ODDS = [85, 12, 3, 0] as const;
export const PAID_ODDS = [70, 20, 9.9, 0.1] as const;

// Economy constants (mirror the contract — immutable on-chain).
export const DRAW_PRICE_BNB = "0.001";
export const DUEL_ENTRY_BNB = "0.001";
export const DRAW_CAP_PER_TYPE = 2500;
export const MAX_PAID_DRAWS_PER_DAY = 2;
export const MAX_FREE_DUELS_PER_DAY = 3;
export const VAULT_SIZE = 50;
export const LOTTERY_PRIZES_PER_SEASON = 3;
export const SEASON_LENGTH_DAYS = 14;
export const SEASON_LENGTH_SECONDS = 14 * 86400;

// Marketplaces (collection pages exist once the contract is deployed and
// indexed; Element is the primary BSC market).
export const ELEMENT_URL = "https://element.market";
export const OPENSEA_URL = "https://opensea.io";

// ---------------------------------------------------------------------------
// Art. Placeholder samples live directly under /art/. The production set
// lands under /art/parts/<type>-<rarity>.webp (+ /art/robot.webp) and takes
// over automatically — <ArtImg> falls back to the samples until a file
// exists, so swapping the art set needs no code change.
// ---------------------------------------------------------------------------
export const ART_BASE = "/art";

export function partArt(typeSlug: string, raritySlug: string): string {
  return `${ART_BASE}/parts/${typeSlug}-${raritySlug}.webp`;
}

export function partArtFallback(raritySlug: string): string {
  // Only the Weapon line has full sample art today.
  return `${ART_BASE}/weapon-${raritySlug}.webp`;
}

export function robotArt(): string {
  return `${ART_BASE}/robot.webp`;
}

export function robotArtFallback(): string {
  return `${ART_BASE}/robot-vector.webp`;
}

export function utcDayNow(): number {
  return Math.floor(Date.now() / 1000 / 86400);
}
