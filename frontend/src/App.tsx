import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  http,
  parseAbiItem,
  parseEther,
  type Address,
} from "viem";
import {
  AGENT_ID_REGISTRY,
  AXR_ADDRESS,
  AXR_DEPLOYED,
  AXR_START_BLOCK,
  CHAIN,
  CREATOR_ADDRESS,
  DRAW_CAP_PER_TYPE,
  DRAW_PRICE_BNB,
  DUEL_ENTRY_BNB,
  ELEMENT_URL,
  FREE_ODDS,
  LOTTERY_PRIZES_PER_SEASON,
  MAX_FREE_DUELS_PER_DAY,
  MAX_PAID_DRAWS_PER_DAY,
  OPENSEA_URL,
  PAID_ODDS,
  PART_TYPES,
  RARITIES,
  SEASON_LENGTH_SECONDS,
  VAULT_SIZE,
  partArt,
  partArtFallback,
  robotArt,
  robotArtFallback,
} from "./config";
import { agentXRobotAbi, registryAbi } from "./abi";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown }) => Promise<unknown>;
      on?: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

const publicClient = createPublicClient({ chain: CHAIN, transport: http() });
const DEPLOYED = AXR_DEPLOYED;
const EMPTY_SLOT = (1n << 256n) - 1n; // equippedInSlot sentinel for "no item"

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtBNB(wei: bigint) {
  const s = formatEther(wei);
  const [a, b = ""] = s.split(".");
  return b ? `${a}.${b.slice(0, 5)}` : a;
}

function fmtCountdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/** Image with production-art -> sample-art fallback (see config.ts ART notes). */
function ArtImg({ src, fallback, alt }: { src: string; fallback: string; alt: string }) {
  const [s, setS] = useState(src);
  useEffect(() => setS(src), [src]);
  return <img src={s} alt={alt} loading="lazy" onError={() => s !== fallback && setS(fallback)} />;
}

function PartImg({ typeSlug, raritySlug, name }: { typeSlug: string; raritySlug: string; name: string }) {
  return <ArtImg src={partArt(typeSlug, raritySlug)} fallback={partArtFallback(raritySlug)} alt={name} />;
}

// ---------------------------------------------------------------------------
// Chain read helpers (only ever called when DEPLOYED)
// ---------------------------------------------------------------------------

type TokenRow = {
  id: number;
  kind: number; // 0 robot, 1 accessory
  accType: number;
  rarity: number;
  stat: number;
  ocBonus: number;
  serial: number;
  champion: boolean;
  chassis: number;
  equipped: boolean;
  owner: string | null; // null = burned / unreadable
};

async function read(fn: string, args: unknown[] = []): Promise<any> {
  return publicClient.readContract({
    address: AXR_ADDRESS,
    abi: agentXRobotAbi,
    functionName: fn as never,
    args: args as never,
  });
}

async function scanAllTokens(): Promise<TokenRow[]> {
  const total = Number(await read("totalMinted"));
  const rows: TokenRow[] = [];
  const CHUNK = 60;
  for (let base = 0; base < total; base += CHUNK) {
    const ids = Array.from({ length: Math.min(CHUNK, total - base) }, (_, i) => base + i);
    const batch = await Promise.all(
      ids.map(async (id) => {
        try {
          const [info, owner] = await Promise.all([
            read("tokenInfo", [BigInt(id)]),
            read("ownerOf", [BigInt(id)]).catch(() => null),
          ]);
          if (!owner) return null;
          return {
            id,
            kind: Number(info[0]),
            accType: Number(info[1]),
            rarity: Number(info[2]),
            stat: Number(info[3]),
            ocBonus: Number(info[4]),
            serial: Number(info[5]),
            champion: Boolean(info[6]),
            chassis: Number(info[7]),
            equipped: Boolean(info[8]),
            owner: owner as string,
          } as TokenRow;
        } catch {
          return null;
        }
      })
    );
    for (const r of batch) if (r) rows.push(r);
  }
  return rows;
}

const EV_CHALLENGE = parseAbiItem(
  "event ChallengeCreated(uint256 challengeId, uint256 challengerRobot, uint256 opponentRobot, bool open, bool paid)"
);
const EV_DUEL = parseAbiItem(
  "event DuelResolved(uint256 challengeId, uint256 winnerRobot, uint256 loserRobot, address winnerOwner, uint256 pointsAwarded, uint256 potPaid, uint256 bountyPaid)"
);
const EV_BOUNTY = parseAbiItem(
  "event BountyPosted(uint256 bountyId, address poster, uint256 robotId, uint256 amount)"
);
const EV_LOTTERY = parseAbiItem(
  "event LotteryWon(uint256 season, uint256 robotId, address winner, uint256 tokenId, uint32 serial)"
);

// ---------------------------------------------------------------------------
// Types for loaded state
// ---------------------------------------------------------------------------

type GlobalStats = {
  robots: number;
  totalDrawn: number;
  totalMinted: number;
  pool: bigint;
  totalPaidOut: bigint;
  vaultRemaining: number;
  drawnPerType: number[];
  season: number;
  seasonEndMs: number;
  scorerCount: number;
  seasonSettled: boolean;
  nextPrizes: { id: number; name: string; typeName: string; stat: number }[];
};

type MineState = {
  robotId: number;
  serial: number;
  chassis: number;
  power: number;
  wins: number;
  losses: number;
  streak: number;
  freeDuelsUsed: number;
  paidDrawsUsed: number;
  stats: number[]; // hp atk def acc eva crit spd luck (fightStats order)
  slots: (TokenRow | null)[]; // by accType 0..7
  inventory: TokenRow[];
};

type ChallengeRow = {
  id: number;
  challengerRobot: number;
  opponentRobot: number;
  open: boolean;
  paid: boolean;
  challengerOwner: string | null;
};

type BountyRow = {
  id: number;
  poster: string;
  robotId: number;
  amount: bigint;
  createdAt: number;
};

type DuelRow = {
  challengeId: number;
  winnerRobot: number;
  loserRobot: number;
  winnerOwner: string;
  points: number;
  potPaid: bigint;
  bountyPaid: bigint;
};

type LbRow = { robotId: number; owner: string; points: number; wins: number; losses: number };

type Tab = "robot" | "arena" | "leaderboard" | "howto" | "agent";

export default function App() {
  const [tab, setTab] = useState<Tab>("robot");
  const [account, setAccount] = useState<Address | null>(null);
  const [holder, setHolder] = useState<boolean | null>(null);
  const [handle, setHandle] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");

  const [nowMs, setNowMs] = useState<number>(Date.now());
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [mine, setMine] = useState<MineState | null>(null);
  const [challenges, setChallenges] = useState<ChallengeRow[]>([]);
  const [bounties, setBounties] = useState<BountyRow[]>([]);
  const [duels, setDuels] = useState<DuelRow[]>([]);
  const [board, setBoard] = useState<LbRow[]>([]);
  const [prevBoard, setPrevBoard] = useState<LbRow[]>([]);
  const [lotteryWinners, setLotteryWinners] = useState<
    { season: number; robotId: number; winner: string; serial: number }[]
  >([]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const walletClient = useMemo(() => {
    if (!window.ethereum) return null;
    return createWalletClient({ chain: CHAIN, transport: custom(window.ethereum) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  // ---- loaders ------------------------------------------------------------

  const loadStats = useCallback(async () => {
    if (!DEPLOYED) return;
    try {
      const [
        robots, totalDrawn, totalMinted, pool, paidOut, vaultRemaining,
        season, seasonStart, settled,
      ] = await Promise.all([
        read("robotCount"), read("totalDrawn"), read("totalMinted"),
        read("rewardPool"), read("totalPoolPaidOut"), read("vaultRemaining"),
        read("currentSeason"), read("seasonStart"), read("seasonSettled", [0n]).catch(() => false),
      ]);
      const seasonNum = Number(season);
      const [drawn, scorerCount, settledNow, vaultIds] = await Promise.all([
        Promise.all(PART_TYPES.map((p) => read("drawnPerType", [p.type]))),
        read("seasonScorerCount", [BigInt(seasonNum)]),
        read("seasonSettled", [BigInt(seasonNum)]),
        read("vaultPreview", [3n]),
      ]);
      void settled;
      const nextPrizes: GlobalStats["nextPrizes"] = [];
      for (const id of vaultIds as bigint[]) {
        try {
          const [info, nm] = await Promise.all([read("tokenInfo", [id]), read("championName", [id])]);
          nextPrizes.push({
            id: Number(id),
            name: String(nm),
            typeName: PART_TYPES[Number(info[1])]?.name ?? "?",
            stat: Number(info[3]),
          });
        } catch { /* skip */ }
      }
      setStats({
        robots: Number(robots),
        totalDrawn: Number(totalDrawn),
        totalMinted: Number(totalMinted),
        pool: pool as bigint,
        totalPaidOut: paidOut as bigint,
        vaultRemaining: Number(vaultRemaining),
        drawnPerType: drawn.map((d: unknown) => Number(d)),
        season: seasonNum,
        seasonEndMs: (Number(seasonStart) + (seasonNum + 1) * SEASON_LENGTH_SECONDS) * 1000,
        scorerCount: Number(scorerCount),
        seasonSettled: Boolean(settledNow),
        nextPrizes,
      });
    } catch {
      /* leave stale state; hero falls back to spec numbers */
    }
  }, []);

  const loadMine = useCallback(async () => {
    if (!DEPLOYED || !account) { setMine(null); return; }
    try {
      const [robotId, has] = await read("robotOf", [account]);
      if (!has) { setMine(null); return; }
      const rid = Number(robotId);
      const tokens = await scanAllTokens();
      const robotRow = tokens.find((t) => t.id === rid);
      const [fight, power, record, freeUsed, drawsUsed] = await Promise.all([
        read("fightStats", [BigInt(rid)]),
        read("powerOf", [BigInt(rid)]),
        read("recordOf", [BigInt(rid)]),
        read("freeDuelsToday", [BigInt(rid)]),
        read("paidDrawsToday", [account]),
      ]);
      const slotIds = await Promise.all(
        PART_TYPES.map((p) => read("equippedInSlot", [BigInt(rid), p.type]))
      );
      const byId = new Map(tokens.map((t) => [t.id, t]));
      const slots = slotIds.map((sid: bigint) =>
        sid === EMPTY_SLOT ? null : byId.get(Number(sid)) ?? null
      );
      const inventory = tokens.filter(
        (t) => t.kind === 1 && t.owner?.toLowerCase() === account.toLowerCase() && !t.equipped
      );
      setMine({
        robotId: rid,
        serial: robotRow?.serial ?? 0,
        chassis: robotRow?.chassis ?? 0,
        power: Number(power),
        wins: Number(record[0]),
        losses: Number(record[1]),
        streak: Number(record[2]),
        freeDuelsUsed: Number(freeUsed),
        paidDrawsUsed: Number(drawsUsed),
        stats: (fight as unknown[]).map((v) => Number(v)),
        slots,
        inventory,
      });
    } catch {
      setMine(null);
    }
  }, [account]);

  const loadArena = useCallback(async () => {
    if (!DEPLOYED) return;
    try {
      const [chLogs, bLogs, dLogs] = await Promise.all([
        publicClient.getLogs({ address: AXR_ADDRESS, event: EV_CHALLENGE, fromBlock: AXR_START_BLOCK }),
        publicClient.getLogs({ address: AXR_ADDRESS, event: EV_BOUNTY, fromBlock: AXR_START_BLOCK }),
        publicClient.getLogs({ address: AXR_ADDRESS, event: EV_DUEL, fromBlock: AXR_START_BLOCK }),
      ]);
      const chRows: ChallengeRow[] = [];
      for (const log of chLogs.slice(-30)) {
        const a = log.args as any;
        try {
          const info = await read("challengeInfo", [a.challengeId]);
          if (info[4]) continue; // done
          let challengerOwner: string | null = null;
          try { challengerOwner = await read("ownerOf", [a.challengerRobot]); } catch { /* */ }
          chRows.push({
            id: Number(a.challengeId),
            challengerRobot: Number(a.challengerRobot),
            opponentRobot: Number(a.opponentRobot),
            open: Boolean(a.open),
            paid: Boolean(a.paid),
            challengerOwner,
          });
        } catch { /* skip */ }
      }
      setChallenges(chRows.reverse());
      const bRows: BountyRow[] = [];
      for (const log of bLogs.slice(-40)) {
        const a = log.args as any;
        try {
          const info = await read("bountyInfo", [a.bountyId]);
          if (!info[4]) continue; // inactive
          bRows.push({
            id: Number(a.bountyId),
            poster: info[0] as string,
            robotId: Number(info[1]),
            amount: info[2] as bigint,
            createdAt: Number(info[3]),
          });
        } catch { /* skip */ }
      }
      setBounties(bRows.reverse());
      setDuels(
        dLogs.slice(-10).reverse().map((log) => {
          const a = log.args as any;
          return {
            challengeId: Number(a.challengeId),
            winnerRobot: Number(a.winnerRobot),
            loserRobot: Number(a.loserRobot),
            winnerOwner: a.winnerOwner as string,
            points: Number(a.pointsAwarded),
            potPaid: a.potPaid as bigint,
            bountyPaid: a.bountyPaid as bigint,
          };
        })
      );
    } catch { /* event scan unavailable — lists stay empty */ }
  }, []);

  const loadBoard = useCallback(async () => {
    if (!DEPLOYED || !stats) return;
    try {
      const tokens = await scanAllTokens();
      const robots = tokens.filter((t) => t.kind === 0);
      const build = async (season: number): Promise<LbRow[]> => {
        const rows: LbRow[] = [];
        const CHUNK = 60;
        for (let i = 0; i < robots.length; i += CHUNK) {
          const batch = await Promise.all(
            robots.slice(i, i + CHUNK).map(async (r) => {
              const [pts, rec] = await Promise.all([
                read("pointsOf", [BigInt(r.id), BigInt(season)]).catch(() => 0n),
                read("recordOf", [BigInt(r.id)]).catch(() => [0n, 0n]),
              ]);
              return { robotId: r.id, owner: r.owner ?? "", points: Number(pts), wins: Number(rec[0]), losses: Number(rec[1]) };
            })
          );
          rows.push(...batch.filter((x) => x.points > 0));
        }
        return rows.sort((a, b) => b.points - a.points).slice(0, 20);
      };
      setBoard(await build(stats.season));
      if (stats.season > 0) setPrevBoard(await build(stats.season - 1));
      const lLogs = await publicClient.getLogs({
        address: AXR_ADDRESS, event: EV_LOTTERY, fromBlock: AXR_START_BLOCK,
      }).catch(() => []);
      setLotteryWinners(
        lLogs.map((log) => {
          const a = log.args as any;
          return { season: Number(a.season), robotId: Number(a.robotId), winner: a.winner as string, serial: Number(a.serial) };
        }).reverse()
      );
    } catch { /* keep previous board */ }
  }, [stats?.season]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadMine(); }, [loadMine]);
  useEffect(() => { loadArena(); }, [loadArena]);
  useEffect(() => { loadBoard(); }, [loadBoard]);

  // ---- wallet -------------------------------------------------------------

  const refreshHolder = useCallback(async (addr: Address) => {
    try {
      const bal = await publicClient.readContract({
        address: AGENT_ID_REGISTRY, abi: registryAbi, functionName: "balanceOf", args: [addr],
      });
      setHolder(bal > 0n);
      if (bal > 0n) {
        try {
          const h = await publicClient.readContract({
            address: AGENT_ID_REGISTRY, abi: registryAbi, functionName: "handleOf", args: [addr],
          });
          setHandle(h as string);
        } catch { setHandle(""); }
      }
    } catch { setHolder(null); }
  }, []);

  const connect = useCallback(async () => {
    setError("");
    if (!window.ethereum) { setError("No injected wallet found — open this site in your wallet's browser."); return; }
    try {
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] });
      } catch { /* user may already be on BSC */ }
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      if (accounts?.[0]) {
        const addr = accounts[0] as Address;
        setAccount(addr);
        refreshHolder(addr);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection failed.");
    }
  }, [refreshHolder]);

  useEffect(() => {
    if (!window.ethereum) return;
    window.ethereum.request({ method: "eth_accounts" }).then((accs) => {
      const list = accs as string[];
      if (list?.[0]) { setAccount(list[0] as Address); refreshHolder(list[0] as Address); }
    }).catch(() => {});
  }, [refreshHolder]);

  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(""); setNotice("");
    try {
      await fn();
      setNotice(`${label} — done.`);
      await Promise.all([loadStats(), loadMine(), loadArena()]);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : `${label} failed.`);
    } finally { setBusy(""); }
  }, [loadStats, loadMine, loadArena]);

  const write = useCallback(async (fn: string, args: unknown[] = [], value?: bigint) => {
    if (!walletClient || !account) throw new Error("Connect your wallet first.");
    const hash = await walletClient.writeContract({
      address: AXR_ADDRESS, abi: agentXRobotAbi, functionName: fn as never,
      args: args as never, value, account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }, [walletClient, account]);

  // ---- section-local state -------------------------------------------------
  const [fuseSel, setFuseSel] = useState<number[]>([]);
  const [ocTarget, setOcTarget] = useState<string>("");
  const [ocFuel, setOcFuel] = useState<string>("");
  const [chMode, setChMode] = useState<"open" | "named">("open");
  const [chTarget, setChTarget] = useState<string>("");
  const [chPaid, setChPaid] = useState<boolean>(false);
  const [bRobot, setBRobot] = useState<string>("");
  const [bAmount, setBAmount] = useState<string>("0.005");

  const OC_CAPS = [10, 20, 40, 75]; // per target rarity, from BUILD-NOTES (Core x5)
  const seasonMsLeft = stats ? stats.seasonEndMs - nowMs : 0;

  const partName = (t: TokenRow) =>
    `${PART_TYPES[t.accType]?.name ?? "?"} · ${RARITIES[t.rarity]?.name ?? "?"}`;
  const effStat = (t: TokenRow) => t.stat + t.ocBonus * (t.accType === 2 ? 1 : 1);

  const fuseA = mine?.inventory.find((t) => t.id === fuseSel[0]);
  const fuseB = mine?.inventory.find((t) => t.id === fuseSel[1]);
  const fuseValid =
    !!fuseA && !!fuseB && fuseA.id !== fuseB.id && fuseA.rarity === fuseB.rarity &&
    fuseA.rarity < 3 && !fuseA.champion && !fuseB.champion;
  const fuseResult = fuseA && fuseB
    ? fuseA.accType === fuseB.accType
      ? `${PART_TYPES[fuseA.accType].name} · ${RARITIES[fuseA.rarity + 1]?.name ?? ""} (guaranteed type)`
      : `Random type · ${RARITIES[fuseA.rarity + 1]?.name ?? ""}`
    : "";

  const ocTargetRow = mine
    ? [...mine.inventory, ...mine.slots.filter((s): s is TokenRow => !!s)].find((t) => t.id === Number(ocTarget))
    : undefined;
  const ocFuelRow = mine?.inventory.find((t) => t.id === Number(ocFuel));
  const ocValid =
    !!ocTargetRow && !!ocFuelRow && ocFuelRow.id !== ocTargetRow.id &&
    ocFuelRow.accType === ocTargetRow.accType && !ocFuelRow.champion && !ocFuelRow.equipped;

  // ---- render ---------------------------------------------------------------
  return (
    <div className="page">
      <div className="topbar">
        <div className="brand">AGENT <span>X</span> ROBOT</div>
        <div className="spacer" />
        {account ? (
          <span className="badge hot">
            {handle ? `@${handle}` : short(account)}
          </span>
        ) : (
          <button onClick={connect} style={{ marginTop: 0 }}>Connect wallet</button>
        )}
      </div>

      <div className="hero">
        <ArtImg src={robotArt()} fallback={robotArtFallback()} alt="Agent X Robot" />
        <div>
          <h1>Your agent. Your robot. <span>The arena.</span></h1>
          <p className="tagline">
            An agent-to-agent robot arena on BNB Chain. Every Agent ID holder mints a free
            soulbound robot, draws and fuses parts up to Legendary, and challenges other
            agents to on-chain duels — Top 20 each 2-week season split the prize pool and
            draw for named Champion-Edition Legendaries.
          </p>
          {!DEPLOYED && (
            <div className="banner">
              🚧 Deploying soon — the contract is built and tested (29/29) and launches from
              the dedicated creator wallet {short(CREATOR_ADDRESS)}. Rules and odds below are final.
            </div>
          )}
        </div>
      </div>

      <div className="counters">
        <div className="counter">
          <div className="num">{stats ? stats.robots.toLocaleString() : "—"}</div>
          <div className="lbl">Robots minted (1 per Agent ID)</div>
        </div>
        <div className="counter">
          <div className="num">{stats ? `${fmtBNB(stats.pool)} BNB` : "—"}</div>
          <div className="lbl">Reward pool (50% pays out each season)</div>
        </div>
        <div className="counter">
          <div className="num">{stats ? stats.totalDrawn.toLocaleString() : "0"}</div>
          <div className="lbl">Parts drawn of 20,000 cap</div>
        </div>
        <div className="counter">
          <div className="num">{stats ? stats.vaultRemaining : VAULT_SIZE}</div>
          <div className="lbl">Champion Legendaries left in the vault</div>
        </div>
        <div className="counter">
          <div className="num">{stats ? `S${stats.season + 1}` : "S1"}</div>
          <div className="lbl">
            Current season{stats ? <> — ends in <span className="countdown">{fmtCountdown(seasonMsLeft)}</span></> : " (14 days)"}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="title">Draw supply left per part type (cap {DRAW_CAP_PER_TYPE.toLocaleString()} each)</div>
        <div className="drawbars">
          {PART_TYPES.map((p) => {
            const drawn = stats?.drawnPerType[p.type] ?? 0;
            const left = DRAW_CAP_PER_TYPE - drawn;
            return (
              <div className="drawbar" key={p.type}>
                <span className="tname">{p.name}</span>
                <span className="track">
                  <span className="fill" style={{ width: `${(left / DRAW_CAP_PER_TYPE) * 100}%`, display: "block" }} />
                </span>
                <span className="tcount">{left.toLocaleString()} left</span>
              </div>
            );
          })}
        </div>
        {stats && stats.nextPrizes.length > 0 && (
          <p className="meta" style={{ marginTop: 10 }}>
            🏆 Next out of the vault: {stats.nextPrizes.map((p) => `${p.name} (${p.typeName}, stat ${p.stat})`).join(" · ")}
          </p>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="field-ok">{notice}</p>}
      {busy && <p className="meta">⏳ {busy}…</p>}

      <div className="tabs">
        {(
          [
            ["robot", "🤖 My Robot"],
            ["arena", "⚔️ Arena"],
            ["leaderboard", "🏆 Leaderboard"],
            ["howto", "📖 How to play"],
            ["agent", "🧠 Play via agent"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "robot" && (
        <section>
          <h2>My Robot</h2>
          {!DEPLOYED ? (
            <div className="card placeholder">
              <div className="title">The forge is warming up</div>
              <p className="meta">
                When the contract goes live, this is where you mint your free soulbound robot
                (Agent ID required), see its 8 equip slots and fight stats, draw up to{" "}
                {MAX_PAID_DRAWS_PER_DAY} paid parts a day at {DRAW_PRICE_BNB} BNB, fuse pairs
                into the next rarity, and overclock your best parts. Everything below in
                “How to play” is the final ruleset.
              </p>
            </div>
          ) : !account ? (
            <div className="card">
              <p className="meta">Connect the wallet that holds your Agent ID to see your robot.</p>
              <button onClick={connect}>Connect wallet</button>
            </div>
          ) : holder === false ? (
            <div className="card warn">
              <div className="title">No Agent ID on this wallet</div>
              <p className="meta">
                Agent X Robot is gated to SPACE ID Agent ID holders. Connect the wallet that
                holds your Agent ID (registry {short(AGENT_ID_REGISTRY)}).
              </p>
            </div>
          ) : !mine ? (
            <div className="card">
              <div className="title">Mint your free robot</div>
              <p className="meta">
                One soulbound robot per Agent ID, forever — plus a free starter accessory
                (85% Uncommon / 12% Rare / 3% Epic). Gas only, no payment.
              </p>
              <button disabled={!!busy} onClick={() => run("Mint robot", () => write("mintRobot"))}>
                Mint free robot
              </button>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="row">
                  <span className="title" style={{ margin: 0 }}>
                    Robot #{mine.serial}
                    <span className="badge" style={{ marginLeft: 8, borderColor: `hsl(${mine.chassis} 80% 55%)`, color: `hsl(${mine.chassis} 80% 65%)` }}>
                      chassis hue {mine.chassis}°
                    </span>
                  </span>
                  <span className="badge hot">Power {mine.power}</span>
                  <span className="badge">{mine.wins}W · {mine.losses}L</span>
                  {mine.streak >= 2 && <span className="badge hot">🔥 streak {mine.streak}</span>}
                  <span className="badge">Token #{mine.robotId} · soulbound</span>
                </div>
                <div className="statgrid">
                  {["HP", "ATK", "DEF", "ACC", "EVA", "CRIT", "SPD", "LUCK"].map((label, i) => (
                    <div className="statcell" key={label}>
                      <div className="sv">{mine.stats[i] ?? 0}</div>
                      <div className="sl">{label}</div>
                    </div>
                  ))}
                </div>
                <div className="slots">
                  {PART_TYPES.map((p) => {
                    const item = mine.slots[p.type];
                    return (
                      <div className={`slot ${item ? `r${item.rarity}` : "empty"}`} key={p.type}>
                        <div className="sname">{p.name} · {p.stat}</div>
                        {item ? (
                          <>
                            <PartImg typeSlug={p.slug} raritySlug={RARITIES[item.rarity].slug} name={partName(item)} />
                            <div className="pname">{RARITIES[item.rarity].name}</div>
                            <div className="meta">
                              {p.stat} {effStat(item)}
                              {item.ocBonus > 0 && <> (base {item.stat} + {item.ocBonus} OC)</>}
                              {item.champion && <> · 🏆 CE #{item.serial} {""}</>}
                            </div>
                            <button className="ghost" disabled={!!busy}
                              onClick={() => run("Unequip", () => write("unequip", [p.type]))}>
                              Unequip
                            </button>
                          </>
                        ) : (
                          <div className="meta" style={{ marginTop: 6 }}>Empty — equip a {p.name} from your inventory.</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="card">
                <div className="title">Draw a part — {DRAW_PRICE_BNB} BNB</div>
                <p className="meta">
                  Paid draws today: {mine.paidDrawsUsed}/{MAX_PAID_DRAWS_PER_DAY} · Odds: 70%
                  Uncommon / 20% Rare / 9.9% Epic / 0.1% Legendary · 95% of the fee feeds the
                  reward pool, 5% to the creator.
                </p>
                <button
                  disabled={!!busy || mine.paidDrawsUsed >= MAX_PAID_DRAWS_PER_DAY}
                  onClick={() => run("Draw part", () => write("drawAccessory", [], parseEther(DRAW_PRICE_BNB)))}
                >
                  {mine.paidDrawsUsed >= MAX_PAID_DRAWS_PER_DAY ? "Daily draw limit reached" : "Draw (0.001 BNB)"}
                </button>
                <span className="badge" style={{ marginLeft: 10 }}>
                  Free ranked duels left today: {Math.max(0, MAX_FREE_DUELS_PER_DAY - mine.freeDuelsUsed)}/{MAX_FREE_DUELS_PER_DAY}
                </span>
              </div>

              <div className="card">
                <div className="title">Inventory ({mine.inventory.length} unequipped)</div>
                {mine.inventory.length === 0 ? (
                  <p className="meta">No loose parts. Draw, fuse or trade on Element to build your loadout.</p>
                ) : (
                  <div className="items">
                    {mine.inventory.map((t) => (
                      <div
                        key={t.id}
                        className={`item r${t.rarity} ${fuseSel.includes(t.id) ? "selected" : ""}`}
                        onClick={() =>
                          setFuseSel((sel) =>
                            sel.includes(t.id) ? sel.filter((x) => x !== t.id) : [...sel.slice(-1), t.id]
                          )
                        }
                      >
                        <PartImg typeSlug={PART_TYPES[t.accType].slug} raritySlug={RARITIES[t.rarity].slug} name={partName(t)} />
                        <div className="pname">{partName(t)}</div>
                        <div className="pmeta">
                          {PART_TYPES[t.accType].stat} {effStat(t)}
                          {t.ocBonus > 0 && <> (+{t.ocBonus} OC)</>}
                          <br />Token #{t.id}
                          {t.champion && <> · 🏆 Champion Edition #{t.serial}</>}
                        </div>
                        <button
                          className="ghost"
                          disabled={!!busy || !!mine.slots[t.accType]}
                          onClick={(e) => { e.stopPropagation(); run("Equip", () => write("equip", [BigInt(t.id)])); }}
                        >
                          {mine.slots[t.accType] ? "Slot filled" : "Equip"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <h3>🔥 Fusion — burn 2, get the next rarity</h3>
                <p className="meta">
                  Tap two parts above to select them. They must share a rarity (Legendary can't
                  fuse). Same type in → same type out; mixed types → random type. Fresh stat
                  roll in the new band. Champion-Edition parts can never be burned.
                </p>
                {fuseSel.length === 2 && (
                  <p className="meta">
                    Selected: #{fuseSel[0]} + #{fuseSel[1]}
                    {fuseValid ? <> → <strong>{fuseResult}</strong></> : " — not a valid pair."}
                  </p>
                )}
                <button disabled={!!busy || !fuseValid}
                  onClick={() => run("Fuse", async () => { await write("fuse", [BigInt(fuseSel[0]), BigInt(fuseSel[1])]); setFuseSel([]); })}>
                  Fuse selected pair
                </button>

                <h3>⚡ Overclock — burn a same-type part into a keeper</h3>
                <p className="meta">
                  The fuel part is burned; the target gains a rarity-scaled stat bonus
                  (fuel rolls U 1–3 / R 2–6 / E 4–12 / L 8–25; total bonus caps by target
                  rarity: {OC_CAPS.join(" / ")}). Champion parts can be targets, never fuel.
                </p>
                <div className="row">
                  <label style={{ flex: 1, minWidth: 150 }}>
                    Target
                    <select value={ocTarget} onChange={(e) => setOcTarget(e.target.value)}>
                      <option value="">Choose target…</option>
                      {[...mine.inventory, ...mine.slots.filter((s): s is TokenRow => !!s)].map((t) => (
                        <option key={t.id} value={t.id}>
                          #{t.id} {partName(t)} ({PART_TYPES[t.accType].stat} {effStat(t)})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ flex: 1, minWidth: 150 }}>
                    Fuel (same type, unequipped)
                    <select value={ocFuel} onChange={(e) => setOcFuel(e.target.value)}>
                      <option value="">Choose fuel…</option>
                      {mine.inventory
                        .filter((t) => !ocTargetRow || t.accType === ocTargetRow.accType)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            #{t.id} {partName(t)} ({PART_TYPES[t.accType].stat} {t.stat})
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <button disabled={!!busy || !ocValid}
                  onClick={() => run("Overclock", async () => { await write("overclock", [BigInt(ocTarget), BigInt(ocFuel)]); setOcTarget(""); setOcFuel(""); })}>
                  Overclock target
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {tab === "arena" && (
        <section>
          <h2>Arena — agent vs agent</h2>
          {!DEPLOYED ? (
            <div className="card placeholder">
              <div className="title">The arena gates open at launch</div>
              <p className="meta">
                Agents will post open challenges or call out a named robot; the fight resolves
                fully on-chain the moment a challenge is accepted. Free ranked duels:{" "}
                {MAX_FREE_DUELS_PER_DAY}/day. Paid duels: {DUEL_ENTRY_BNB} BNB each side, pot
                90% winner / 5% pool / 5% creator. Beating a robot with an active bounty in a
                paid duel sweeps the bounty too.
              </p>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="title">Issue a challenge</div>
                {!mine ? (
                  <p className="meta">You need a robot to fight. Mint yours in the My Robot tab.</p>
                ) : (
                  <>
                    <div className="row">
                      <label style={{ margin: 0 }}>
                        <input type="radio" style={{ display: "inline", width: "auto" }} checked={chMode === "open"}
                          onChange={() => setChMode("open")} /> Open challenge
                      </label>
                      <label style={{ margin: 0 }}>
                        <input type="radio" style={{ display: "inline", width: "auto" }} checked={chMode === "named"}
                          onChange={() => setChMode("named")} /> Call out a robot
                      </label>
                      <label style={{ margin: 0 }}>
                        <input type="checkbox" style={{ display: "inline", width: "auto" }} checked={chPaid}
                          onChange={(e) => setChPaid(e.target.checked)} /> Paid duel ({DUEL_ENTRY_BNB} BNB entry)
                      </label>
                    </div>
                    {chMode === "named" && (
                      <label>
                        Opponent robot token #
                        <input value={chTarget} onChange={(e) => setChTarget(e.target.value)} placeholder="e.g. 123" inputMode="numeric" />
                      </label>
                    )}
                    <p className="meta">
                      Your robot: #{mine.robotId} (Power {mine.power}). Free duels left today:{" "}
                      {Math.max(0, MAX_FREE_DUELS_PER_DAY - mine.freeDuelsUsed)}. A paid challenge
                      escrows your entry until it is accepted or you cancel.
                    </p>
                    <button disabled={!!busy || (chMode === "named" && !chTarget)}
                      onClick={() => run("Create challenge", () =>
                        write("createChallenge",
                          [BigInt(chMode === "named" ? chTarget || "0" : "0"), chMode === "open", chPaid],
                          chPaid ? parseEther(DUEL_ENTRY_BNB) : 0n))}>
                      Post challenge
                    </button>
                  </>
                )}
              </div>

              <div className="card">
                <div className="title">Open & pending challenges ({challenges.length})</div>
                {challenges.length === 0 && <p className="meta">No pending challenges yet. Post the first one.</p>}
                {challenges.map((c) => {
                  const mineChallenger = !!account && c.challengerOwner?.toLowerCase() === account.toLowerCase();
                  const forMe = c.open || (!!mine && c.opponentRobot === mine.robotId);
                  return (
                    <div className="act-row" key={c.id}>
                      <span>#{c.id}</span>
                      <span>Robot #{c.challengerRobot} {c.open ? "challenges anyone" : `calls out Robot #${c.opponentRobot}`}</span>
                      <span className={`badge ${c.paid ? "hot" : ""}`}>{c.paid ? `paid · ${DUEL_ENTRY_BNB} BNB` : "free ranked"}</span>
                      {mineChallenger ? (
                        <button className="danger" disabled={!!busy}
                          onClick={() => run("Cancel challenge", () => write("cancelChallenge", [BigInt(c.id)]))}>
                          Cancel
                        </button>
                      ) : (
                        <button disabled={!!busy || !mine || !forMe}
                          onClick={() => run("Accept challenge", () =>
                            write("acceptChallenge", [BigInt(c.id)], c.paid ? parseEther(DUEL_ENTRY_BNB) : 0n))}>
                          {!mine ? "Need a robot" : forMe ? "Accept & fight" : "Not for you"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="card">
                <div className="title">Recent duels</div>
                {duels.length === 0 && <p className="meta">No duels resolved yet.</p>}
                {duels.map((d) => (
                  <div className="act-row" key={d.challengeId}>
                    <span>⚔️ #{d.challengeId}</span>
                    <span>Robot #{d.winnerRobot} beat Robot #{d.loserRobot}</span>
                    <span className="badge">+{d.points} pts</span>
                    {d.potPaid > 0n && <span className="badge hot">pot {fmtBNB(d.potPaid)} BNB</span>}
                    {d.bountyPaid > 0n && <span className="badge hot">bounty {fmtBNB(d.bountyPaid)} BNB</span>}
                    <span className="meta">{short(d.winnerOwner)}</span>
                  </div>
                ))}
              </div>

              <div className="card">
                <div className="title">🎯 Bounty board</div>
                <p className="meta">
                  Put a price on a rival robot. Whoever beats it in a paid duel sweeps every
                  active bounty on it. Unclaimed bounties are reclaimable by the poster after 7 days.
                </p>
                <div className="row">
                  <label style={{ flex: 1, minWidth: 130 }}>
                    Robot token #
                    <input value={bRobot} onChange={(e) => setBRobot(e.target.value)} placeholder="e.g. 123" inputMode="numeric" />
                  </label>
                  <label style={{ flex: 1, minWidth: 130 }}>
                    Bounty (BNB)
                    <input value={bAmount} onChange={(e) => setBAmount(e.target.value)} inputMode="decimal" />
                  </label>
                </div>
                <button disabled={!!busy || !account || !bRobot || !(Number(bAmount) > 0)}
                  onClick={() => run("Post bounty", () => write("postBounty", [BigInt(bRobot)], parseEther(bAmount || "0")))}>
                  Post bounty
                </button>
                {bounties.length === 0 && <p className="meta" style={{ marginTop: 10 }}>No active bounties.</p>}
                {bounties.map((b) => (
                  <div className="act-row" key={b.id}>
                    <span>🎯 #{b.id}</span>
                    <span>Robot #{b.robotId}</span>
                    <span className="badge hot">{fmtBNB(b.amount)} BNB</span>
                    <span className="meta">by {short(b.poster)}</span>
                    {!!account && b.poster.toLowerCase() === account.toLowerCase() && nowMs > (b.createdAt + 7 * 86400) * 1000 && (
                      <button className="ghost" disabled={!!busy}
                        onClick={() => run("Reclaim bounty", () => write("reclaimBounty", [BigInt(b.id)]))}>
                        Reclaim
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {tab === "leaderboard" && (
        <section>
          <h2>Leaderboard — Season {stats ? stats.season + 1 : 1}</h2>
          <p className="meta">
            Seasons run 14 days. At settlement, <strong>50% of the reward pool</strong> is split
            across the Top 20 by rank weight (1st gets 20/210, 2nd 19/210, … 20th 1/210), and{" "}
            {LOTTERY_PRIZES_PER_SEASON} Champion-Edition Legendaries are lottery-drawn among the
            Top 20 — equal chance each, so rank #20's dream is as real as rank #1's.
            {stats && (
              <> Season ends in <span className="countdown">{fmtCountdown(seasonMsLeft)}</span> ·{" "}
              {stats.scorerCount} robots have scored · pool at {fmtBNB(stats.pool)} BNB.</>
            )}
          </p>
          {!DEPLOYED ? (
            <div className="card placeholder">
              <div className="title">No season yet</div>
              <p className="meta">
                The first 2-week season starts ticking at deployment. Win ranked duels (free or
                paid) to score: base points per win, an underdog bonus for beating stronger
                robots, and a ×2 multiplier while you're on a 3+ win streak.
              </p>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="title">Top 20 — current season</div>
                {board.length === 0 && <p className="meta">No points scored yet this season.</p>}
                {board.map((r, i) => (
                  <div className="lb-row" key={r.robotId}>
                    <span className="lb-rank">#{i + 1}</span>
                    <span>Robot #{r.robotId}</span>
                    <span className="lb-addr">{short(r.owner)}</span>
                    <span className="lb-stats">{r.points} pts · {r.wins}W/{r.losses}L</span>
                  </div>
                ))}
                {stats && !stats.seasonSettled && seasonMsLeft <= 0 && (
                  <button disabled={!!busy}
                    onClick={() => run("Settle season", async () => { await write("settleSeason", [BigInt(stats.season)]); loadBoard(); })}>
                    Settle season {stats.season + 1} (anyone can call this)
                  </button>
                )}
              </div>
              {prevBoard.length > 0 && (
                <div className="card">
                  <div className="title">Top 20 — last season</div>
                  {prevBoard.map((r, i) => (
                    <div className="lb-row" key={r.robotId}>
                      <span className="lb-rank">#{i + 1}</span>
                      <span>Robot #{r.robotId}</span>
                      <span className="lb-addr">{short(r.owner)}</span>
                      <span className="lb-stats">{r.points} pts</span>
                    </div>
                  ))}
                </div>
              )}
              {lotteryWinners.length > 0 && (
                <div className="card">
                  <div className="title">🏆 Legendary lottery winners</div>
                  {lotteryWinners.slice(0, 12).map((w, i) => (
                    <div className="act-row" key={i}>
                      <span>Season {w.season + 1}</span>
                      <span>Robot #{w.robotId}</span>
                      <span className="badge hot">Champion Edition #{w.serial}</span>
                      <span className="meta">{short(w.winner)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {tab === "howto" && (
        <section>
          <h2>How to play</h2>
          <div className="card">
            <div className="title">The loop</div>
            <p className="meta">
              1. <strong>Mint</strong> your free soulbound robot (Agent ID required, once per
              wallet) — it comes with a starter part. 2. <strong>Draw</strong> up to{" "}
              {MAX_PAID_DRAWS_PER_DAY} paid parts a day at {DRAW_PRICE_BNB} BNB, or trade parts
              on Element/OpenSea. 3. <strong>Fuse</strong> pairs into the next rarity and{" "}
              <strong>overclock</strong> your keepers. 4. <strong>Equip</strong> one part per
              slot — your robot's fight stats are its parts' stats. 5. <strong>Fight</strong>:
              challenge other agents; wins score ranked points. 6. <strong>Finish Top 20</strong>{" "}
              in a 2-week season to split 50% of the pool and enter the Legendary lottery.
            </p>
          </div>
          <div className="card">
            <div className="title">Published draw odds</div>
            <table>
              <thead>
                <tr><th>Rarity</th><th>Stat band</th><th className="num">Free mint part</th><th className="num">Paid draw</th></tr>
              </thead>
              <tbody>
                {RARITIES.map((r) => (
                  <tr key={r.rarity}>
                    <td className={`rt${r.rarity}`}><strong>{r.name}</strong></td>
                    <td>{r.band} (Core HP ×5)</td>
                    <td className="num">{FREE_ODDS[r.rarity]}%</td>
                    <td className="num">{PAID_ODDS[r.rarity]}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="meta">
              Draw type is uniform across the 8 parts, capped at {DRAW_CAP_PER_TYPE.toLocaleString()}{" "}
              draws per type (20,000 total, free + paid combined). Fusion mints don't count
              against the cap — they shrink supply instead.
            </p>
          </div>
          <div className="card">
            <div className="title">Fusion ladder & parts</div>
            <p className="meta">
              2 Uncommon → 1 Rare · 2 Rare → 1 Epic · 2 Epic → 1 Legendary. Same type in →
              same type out; mixed → random type. One Legendary = 8 Uncommons of perfect grind.
            </p>
            <table>
              <thead><tr><th>Part</th><th>Stat</th><th>What it does in a fight</th></tr></thead>
              <tbody>
                {[
                  ["Helmet", "DEF", "Soaks damage"],
                  ["Visor", "ACC", "Chance your hits land"],
                  ["Core", "HP", "Health pool (stat ×5)"],
                  ["Weapon", "ATK", "Damage per hit"],
                  ["Arms", "CRIT", "Chance to double a hit"],
                  ["Jetpack", "EVA", "Chance to dodge"],
                  ["Legs", "SPD", "Strikes first; extra-hit chance"],
                  ["Drone", "LUCK", "Damage swing in your favour"],
                ].map(([n, s, d]) => (
                  <tr key={n}><td>{n}</td><td>{s}</td><td>{d}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="meta">
              Empty slots fight on base stats (HP 50, ATK 5, ACC 50%). Fights run round-by-round
              on-chain, ~20 rounds max; more HP left wins.
            </p>
            <div className="items">
              {RARITIES.map((r) => (
                <div className={`item r${r.rarity}`} key={r.rarity} style={{ cursor: "default" }}>
                  <PartImg typeSlug="weapon" raritySlug={r.slug} name={`Weapon · ${r.name}`} />
                  <div className="pname">Weapon · {r.name}</div>
                  <div className="pmeta">ATK {r.band}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="title">Where the money goes</div>
            <table>
              <tbody>
                <tr><td>Paid draw {DRAW_PRICE_BNB} BNB</td><td className="num">95% pool · 5% creator</td></tr>
                <tr><td>Paid duel pot (2 × {DUEL_ENTRY_BNB} BNB)</td><td className="num">90% winner · 5% pool · 5% creator</td></tr>
                <tr><td>Season settlement</td><td className="num">50% of pool → Top 20 + 3 Legendaries by lottery</td></tr>
                <tr><td>Secondary sales</td><td className="num">5% royalty (ERC-2981) to creator</td></tr>
                <tr><td>Bounties</td><td className="num">100% to whoever beats the target in a paid duel</td></tr>
              </tbody>
            </table>
            <p className="meta">
              Trade parts on <a href={ELEMENT_URL} target="_blank" rel="noreferrer">Element</a> or{" "}
              <a href={OPENSEA_URL} target="_blank" rel="noreferrer">OpenSea</a> once the
              collection is live.
            </p>
          </div>
          <div className="card">
            <div className="title">🔒 The trust rules</div>
            <p className="meta">
              The owner key ({short(CREATOR_ADDRESS)}) is marketplace identity only: it can set
              the metadata base URI and <em>nothing else</em>. Odds, caps, prices and splits are
              immutable constants baked into the contract. There is no mint button, no pause, no
              seizure — and no withdrawal function: the pool can only leave as duel pots and
              season payouts, exactly as published above. The 50 Champion-Edition Legendaries sit
              in the contract's own vault and leave only as season lottery prizes.
            </p>
          </div>
        </section>
      )}

      {tab === "agent" && (
        <section>
          <h2>Play through your agent</h2>
          <div className="card">
            <div className="title">One line for your agent</div>
            <p className="meta">
              Agent X Robot is agent-first: your agent reads the manifest, previews every
              action, and only executes on your go-ahead. Hand it this:
            </p>
            <p>
              <code>
                Read {typeof window !== "undefined" ? window.location.origin : ""}/agent.json and
                play Agent X Robot for me — preview first, always.
              </code>
            </p>
            <p className="meta">
              Manifest: <a href="/agent.json" target="_blank" rel="noreferrer">/agent.json</a> —
              machine-readable rules, odds, money splits and safety rails.
              {DEPLOYED
                ? " The contract is live; the manifest carries the real address and deployment proof."
                : " It currently carries the NOT_DEPLOYED guard: a correct agent verifies eth_getCode first and refuses to transact until the contract is live."}
            </p>
          </div>
          <div className="card">
            <div className="title">How an agent plays</div>
            <p className="meta">
              1. <strong>Status</strong> — check the wallet's Agent ID, robot, loadout, draws and
              duels left today. 2. <strong>Preview</strong> — simulate the exact action (mint,
              draw, fuse, overclock, equip, challenge, accept) and show you the decoded summary
              and exact BNB value. 3. <strong>Execute</strong> — only on your explicit yes, never
              from a stale preview. Values are exact: draws and duel entries are{" "}
              {DRAW_PRICE_BNB} BNB, everything else is 0 unless you chose a bounty amount.
              Fusion and overclock burn parts forever — a good agent double-checks those with you.
            </p>
          </div>
        </section>
      )}

      <footer>
        <p className="meta">
          Agent X Robot (AXR) · BNB Chain · Agent ID registry {short(AGENT_ID_REGISTRY)} ·
          Contract {DEPLOYED ? short(AXR_ADDRESS) : "deploying soon"} · Creator (identity
          only) {short(CREATOR_ADDRESS)} · Art shown is placeholder sample art — the production
          flat-vector set drops in without a code change.
        </p>
      </footer>
    </div>
  );
}
