// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Agent X Robot (AXR) — agent-to-agent robot arena (BNB Chain, Agent ID holders)
/// @notice Implements DESIGN.md (2026-11-25) in a single self-contained ERC-721.
///
/// GAME SUMMARY:
/// - FREE MINT: each Agent ID holder mints ONE soulbound Robot + 1 random
///   accessory (odds 85% Uncommon / 12% Rare / 3% Epic / 0% Legendary).
/// - PAID DRAW: 0.001 BNB, max 2/day per Robot, odds 70/20/9.9/0.1.
///   95% of every draw enters the reward pool, 5% is sent to the creator.
/// - ACCESSORIES: 8 types (Helmet DEF, Visor ACC, Core HP, Weapon ATK,
///   Arms CRIT, Jetpack EVA, Legs SPD, Drone LUCK), 4 rarities with stat
///   bands 1-10 / 11-25 / 26-50 / 51-100 (Core stat x5 = HP). Draw supply
///   is capped at 2,500 per type (20,000 total); fusion mints are exempt.
/// - FUSION: burn 2 same-rarity parts -> 1 of the next rarity. Same type
///   in -> same type out; mixed types -> random type out.
/// - OVERCLOCK: burn a same-type part into a target part for a stat bonus
///   (bonus roll scales with fuel rarity; total bonus hard-capped per
///   target rarity — see OC_BONUS_CAP).
/// - ARENA: agent-to-agent challenges. Free ranked duels (3/day/robot)
///   and paid duels (0.001 BNB each side; pot 90% winner / 5% pool /
///   5% creator). Fights resolve on-chain, round by round.
/// - SEASONS: 2 weeks. settleSeason() pays 50% of the pool to the Top 20
///   by season points (rank weights 21-rank, total 210) and runs the
///   Legendary lottery: 3 distinct Top-20 robots each win 1 Legendary
///   from the prize vault.
/// - PRIZE VAULT: 50 Champion-Edition Legendaries (serials CE-01..CE-50,
///   each with a unique name) minted to THIS contract at construction.
///   They never count against draw caps and can only leave via the lottery.
/// - BOUNTY BOARD: escrow BNB on a rival Robot; the first paid-duel winner
///   against it claims the bounty in full. Poster reclaims after 7 days.
///
/// OWNER = ZERO GAME POWER: the deployer is owner() purely so marketplaces
/// (Element / OpenSea, ERC-173) recognise the collection creator. The
/// owner's ONLY privilege is setBaseURI (metadata). There is NO withdraw,
/// NO mint, NO pause and NO way to change odds, caps, prices or splits —
/// they are immutable constants. Pool BNB leaves ONLY as season payouts;
/// creator cuts are sent automatically by the game functions themselves.
///
/// RANDOMNESS (honest limits): draws, fights and the lottery use
/// keccak256 over blockhash(block.number-1), block.prevrandao, the caller
/// and monotonic counters. This is game-grade entropy, not VRF: a
/// sophisticated caller who can land a transaction in a chosen block can
/// bias their own rolls. Impact is bounded (2 paid draws/day, duel pots
/// are player-funded, season payouts are proportional). See BUILD-NOTES.md.

interface IAgentID {
    function balanceOf(address owner) external view returns (uint256);
}

contract AgentXRobot {
    // ----- ERC-721 metadata -----
    string public constant name = "Agent X Robot";
    string public constant symbol = "AXR";

    // ----- Token kinds -----
    uint8 public constant KIND_ROBOT = 0;
    uint8 public constant KIND_ACCESSORY = 1;

    // ----- Economy / game constants (immutable by construction) -----
    uint256 public constant DRAW_PRICE = 0.001 ether;
    uint256 public constant DUEL_ENTRY = 0.001 ether;
    uint256 public constant MAX_PAID_DRAWS_PER_DAY = 2;
    uint256 public constant MAX_FREE_DUELS_PER_DAY = 3;
    uint256 public constant DRAW_CAP_PER_TYPE = 2500;
    uint256 public constant VAULT_SIZE = 50;
    uint256 public constant LOTTERY_PRIZES_PER_SEASON = 3;
    uint256 public constant SEASON_LENGTH = 14 days;
    uint256 public constant BOUNTY_RECLAIM_DELAY = 7 days;
    uint256 public constant ROYALTY_BPS = 500; // 5%
    uint256 public constant BASE_HP = 50;
    uint256 public constant BASE_ATK = 5;
    uint256 public constant BASE_ACC = 50; // percent, before Visor stat

    /// @notice SPACE ID Agent ID registry on BNB Chain (immutable).
    IAgentID public immutable agentIdRegistry;
    /// @notice Deployer = collection creator (marketplace identity only).
    address public immutable creator;
    /// @notice Season clock start (deployment timestamp).
    uint256 public immutable seasonStart;

    // ----- Tokens -----
    struct TokenInfo {
        uint8 kind; // KIND_*
        uint8 accType; // accessory: 0..7 (robot: 0)
        uint8 rarity; // accessory: 0..3 (robot: 0)
        uint32 stat; // rolled stat (Core already x5)
        uint32 ocBonus; // overclock bonus (same units as stat)
        uint32 serial; // robot #: 1.. ; champion legendary: CE serial 1..50
        bool champion; // Champion-Edition prize-vault legendary
        uint16 chassis; // robot: colour/face seed 0..359
    }

    TokenInfo[] private _tokens;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => bool) private _burned;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // ----- Robots / loadout -----
    mapping(address => uint256) private _robotOf; // owner -> robot token id
    mapping(address => bool) private _hasRobot;
    uint256 private _robotCount;
    // robotId -> slot type -> accessory token id + 1 (0 = empty)
    mapping(uint256 => mapping(uint8 => uint256)) private _equipped;
    // accessory token id -> robot id + 1 (0 = not equipped)
    mapping(uint256 => uint256) private _equippedIn;

    // ----- Draws -----
    uint256[8] private _drawnPerType;
    mapping(address => mapping(uint256 => uint256)) private _paidDrawsOnDay;
    uint256 private _randNonce;

    // ----- Reward pool -----
    uint256 private _pool;
    uint256 private _totalPoolPaidOut;

    // ----- Duels -----
    struct Challenge {
        uint256 challengerRobot;
        uint256 opponentRobot; // 0 = open challenge (robot ids start at 0, so
        // open challenges are flagged by `open` below, opponent ignored)
        address challengerOwner;
        bool open;
        bool paid;
        bool done;
    }
    Challenge[] private _challenges;
    mapping(uint256 => mapping(uint256 => uint256)) private _freeDuelsOnDay; // robotId -> day -> count
    mapping(uint256 => uint256) private _wins;
    mapping(uint256 => uint256) private _losses;
    mapping(uint256 => uint256) private _streak; // consecutive ranked wins

    // ----- Seasons / points -----
    mapping(uint256 => mapping(uint256 => uint256)) private _points; // robotId -> season -> points
    mapping(uint256 => uint256[]) private _seasonRobots; // season -> robots that scored
    mapping(uint256 => mapping(uint256 => bool)) private _scoredInSeason;
    mapping(uint256 => bool) private _seasonSettled;

    // ----- Prize vault -----
    uint256[] private _vaultIds;
    uint256 private _vaultCursor;
    string[] private _ceNames;

    // ----- Bounties -----
    struct Bounty {
        address poster;
        uint256 robotId;
        uint256 amount;
        uint256 createdAt;
        bool active;
    }
    Bounty[] private _bounties;
    mapping(uint256 => uint256[]) private _bountiesOn; // robotId -> bounty ids

    // ----- Metadata -----
    string private _baseURI;

    // ----- Events -----
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event RobotMinted(address indexed user, uint256 robotId, uint256 accessoryId, uint8 accType, uint8 rarity);
    event AccessoryDrawn(address indexed user, uint256 tokenId, uint8 accType, uint8 rarity, uint32 stat, bool paid);
    event Fused(address indexed user, uint256 burnedA, uint256 burnedB, uint256 newTokenId, uint8 accType, uint8 rarity);
    event Overclocked(address indexed user, uint256 targetId, uint256 fuelId, uint32 addedBonus, uint32 totalBonus);
    event Equipped(address indexed user, uint256 robotId, uint256 accessoryId, uint8 accType);
    event Unequipped(address indexed user, uint256 robotId, uint256 accessoryId, uint8 accType);
    event ChallengeCreated(uint256 indexed challengeId, uint256 challengerRobot, uint256 opponentRobot, bool open, bool paid);
    event ChallengeCancelled(uint256 indexed challengeId);
    event DuelResolved(
        uint256 indexed challengeId, uint256 winnerRobot, uint256 loserRobot,
        address winnerOwner, uint256 pointsAwarded, uint256 potPaid, uint256 bountyPaid
    );
    event SeasonSettled(uint256 indexed season, uint256 poolPaid, uint256 topCount);
    event LotteryWon(uint256 indexed season, uint256 robotId, address indexed winner, uint256 tokenId, uint32 serial);
    event BountyPosted(uint256 indexed bountyId, address indexed poster, uint256 indexed robotId, uint256 amount);
    event BountyClaimed(uint256 indexed bountyId, address indexed winner, uint256 amount);
    event BountyReclaimed(uint256 indexed bountyId, address indexed poster, uint256 amount);
    event PoolFunded(address indexed from, uint256 amount);

    constructor(address registry) {
        require(registry != address(0), "zero registry");
        agentIdRegistry = IAgentID(registry);
        creator = msg.sender;
        seasonStart = block.timestamp;
        _ceNames = [
            "SUNFALL", "BASTION", "VOIDPIERCER", "STARFORGE", "NIGHTHAWK",
            "IRONVOW", "PULSAR", "QUANTA", "ZEPHYR", "OBSIDIAN",
            "TEMPEST", "AEGIS", "VORTEX", "SOLSTICE", "MONOLITH",
            "PHANTOM", "TITAN", "NEBULA", "CYCLONE", "ORACLE",
            "SENTINEL", "HAVOC", "ZENITH", "ECLIPSE", "FURY",
            "ONYX", "RAPTOR", "SABLE", "HELIX", "DRIFT",
            "EMBER", "GLACIER", "MAELSTROM", "VECTOR", "WRAITH",
            "PYRE", "CITADEL", "LUMEN", "KESTREL", "ANVIL",
            "ORISON", "HALCYON", "TALON", "UMBRA", "FLUX",
            "GORGON", "MERIDIAN", "SOVEREIGN", "WYVERN", "APEX"
        ];
        // Prize vault: 50 Champion-Edition Legendaries held by this contract.
        for (uint256 i = 0; i < VAULT_SIZE; i++) {
            uint8 accType = uint8(i % 8);
            uint32 stat = _bandRoll(3, accType, _entropy(0xCE00 + i));
            uint256 id = _mintRaw(
                address(this),
                TokenInfo({
                    kind: KIND_ACCESSORY,
                    accType: accType,
                    rarity: 3,
                    stat: stat,
                    ocBonus: 0,
                    serial: uint32(i + 1),
                    champion: true,
                    chassis: 0
                })
            );
            _vaultIds.push(id);
        }
    }

    // ----- Ownership (ERC-173 identity only) -----

    function owner() public view returns (address) {
        return creator;
    }

    /// @notice The owner's ONLY privilege: set the metadata base URI.
    /// Empty base URI = on-chain JSON metadata (the default).
    function setBaseURI(string calldata uri) external {
        require(msg.sender == creator, "not creator");
        _baseURI = uri;
    }

    function baseURI() external view returns (string memory) {
        return _baseURI;
    }

    // ----- Agent ID gate -----

    function hasAgentId(address account) public view returns (bool) {
        return agentIdRegistry.balanceOf(account) > 0;
    }

    // ----- Entropy / rolls -----

    function _entropy(uint256 salt) internal returns (uint256) {
        _randNonce += 1;
        return uint256(
            keccak256(
                abi.encodePacked(
                    blockhash(block.number - 1), block.prevrandao, msg.sender, salt, _randNonce, block.timestamp
                )
            )
        );
    }

    /// @dev Rarity roll. paid: %10000 -> 70/20/9.9/0.1. free: %100 -> 85/12/3/0.
    function _rollRarity(uint256 seed, bool paid) internal pure returns (uint8) {
        if (paid) {
            uint256 r = seed % 10000;
            if (r < 7000) return 0;
            if (r < 9000) return 1;
            if (r < 9990) return 2;
            return 3;
        }
        uint256 r = seed % 100;
        if (r < 85) return 0;
        if (r < 97) return 1;
        return 2;
    }

    /// @dev Stat band for a rarity: 1-10 / 11-25 / 26-50 / 51-100.
    function _band(uint8 rarity) internal pure returns (uint32 lo, uint32 hi) {
        if (rarity == 0) return (1, 10);
        if (rarity == 1) return (11, 25);
        if (rarity == 2) return (26, 50);
        return (51, 100);
    }

    /// @dev Roll a stat in the rarity band; Core (type 2) is HP so it is x5.
    function _bandRoll(uint8 rarity, uint8 accType, uint256 seed) internal pure returns (uint32) {
        (uint32 lo, uint32 hi) = _band(rarity);
        uint32 v = lo + uint32(seed % (hi - lo + 1));
        return accType == 2 ? v * 5 : v;
    }

    /// @dev Pick a draw type honouring the per-type cap: start at seed % 8
    /// and scan forward; reverts when every type is at cap.
    function _pickDrawType(uint256 seed) internal view returns (uint8) {
        uint256 start = seed % 8;
        for (uint256 i = 0; i < 8; i++) {
            uint8 t = uint8((start + i) % 8);
            if (_drawnPerType[t] < DRAW_CAP_PER_TYPE) return t;
        }
        revert("supply exhausted");
    }

    // ----- Internal token plumbing -----

    function _mintRaw(address to, TokenInfo memory info) internal returns (uint256 tokenId) {
        tokenId = _tokens.length;
        _tokens.push(info);
        _owners[tokenId] = to;
        _balances[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    function _burnRaw(uint256 tokenId) internal {
        address from = _owners[tokenId];
        _burned[tokenId] = true;
        _owners[tokenId] = address(0);
        _balances[from] -= 1;
        _tokenApprovals[tokenId] = address(0);
        if (_equippedIn[tokenId] != 0) {
            uint256 robotId = _equippedIn[tokenId] - 1;
            _equipped[robotId][_tokens[tokenId].accType] = 0;
            _equippedIn[tokenId] = 0;
        }
        emit Transfer(from, address(0), tokenId);
    }

    function _transferRaw(address from, address to, uint256 tokenId) internal {
        _tokenApprovals[tokenId] = address(0);
        _owners[tokenId] = to;
        _balances[from] -= 1;
        _balances[to] += 1;
        emit Transfer(from, to, tokenId);
    }

    function _exists(uint256 tokenId) internal view returns (bool) {
        return tokenId < _tokens.length && !_burned[tokenId];
    }

    function _requireAccessory(uint256 tokenId) internal view returns (TokenInfo storage t) {
        require(_exists(tokenId), "token does not exist");
        t = _tokens[tokenId];
        require(t.kind == KIND_ACCESSORY, "not an accessory");
    }

    function _requireNotEquipped(uint256 tokenId) internal view {
        require(_equippedIn[tokenId] == 0, "unequip it first");
    }

    // ----- Free mint -----

    /// @notice Free first mint: ONE soulbound Robot + 1 random accessory.
    /// Agent ID holders only, once per wallet, forever.
    function mintRobot() external returns (uint256 robotId, uint256 accessoryId) {
        require(hasAgentId(msg.sender), "no Agent ID");
        require(!_hasRobot[msg.sender], "robot already minted");
        uint256 seed = _entropy(0xA0B07);
        uint8 accType = _pickDrawType(seed >> 16);
        uint8 rarity = _rollRarity(seed, false);
        uint32 stat = _bandRoll(rarity, accType, seed >> 32);
        _drawnPerType[accType] += 1;

        _hasRobot[msg.sender] = true;
        _robotCount += 1;
        robotId = _mintRaw(
            msg.sender,
            TokenInfo({
                kind: KIND_ROBOT,
                accType: 0,
                rarity: 0,
                stat: 0,
                ocBonus: 0,
                serial: uint32(_robotCount),
                champion: false,
                chassis: uint16(seed % 360)
            })
        );
        _robotOf[msg.sender] = robotId;
        accessoryId = _mintRaw(
            msg.sender,
            TokenInfo({
                kind: KIND_ACCESSORY,
                accType: accType,
                rarity: rarity,
                stat: stat,
                ocBonus: 0,
                serial: 0,
                champion: false,
                chassis: 0
            })
        );
        emit RobotMinted(msg.sender, robotId, accessoryId, accType, rarity);
        emit AccessoryDrawn(msg.sender, accessoryId, accType, rarity, stat, false);
    }

    // ----- Paid draw -----

    /// @notice Paid accessory draw: exactly 0.001 BNB, max 2 per UTC day
    /// per Robot owner. 95% to the reward pool, 5% to the creator.
    function drawAccessory() external payable returns (uint256 tokenId) {
        require(_hasRobot[msg.sender], "no robot");
        require(msg.value == DRAW_PRICE, "price is 0.001 BNB");
        uint256 day = block.timestamp / 1 days;
        require(_paidDrawsOnDay[msg.sender][day] < MAX_PAID_DRAWS_PER_DAY, "draw limit reached");
        _paidDrawsOnDay[msg.sender][day] += 1;

        uint256 seed = _entropy(0xD0A11);
        uint8 accType = _pickDrawType(seed >> 16);
        uint8 rarity = _rollRarity(seed, true);
        uint32 stat = _bandRoll(rarity, accType, seed >> 32);
        _drawnPerType[accType] += 1;

        uint256 creatorCut = (msg.value * 5) / 100;
        _pool += msg.value - creatorCut;
        tokenId = _mintRaw(
            msg.sender,
            TokenInfo({
                kind: KIND_ACCESSORY,
                accType: accType,
                rarity: rarity,
                stat: stat,
                ocBonus: 0,
                serial: 0,
                champion: false,
                chassis: 0
            })
        );
        emit AccessoryDrawn(msg.sender, tokenId, accType, rarity, stat, true);
        (bool ok, ) = creator.call{value: creatorCut}("");
        require(ok, "creator cut transfer failed");
    }

    receive() external payable {
        _pool += msg.value;
        emit PoolFunded(msg.sender, msg.value);
    }

    // ----- Fusion -----

    /// @notice Burn 2 accessories of the same rarity -> 1 of the next
    /// rarity. Same type in -> same type out; mixed types -> random type.
    /// The result gets a fresh stat roll in its new band. Fusion mints do
    /// NOT count against the draw caps.
    function fuse(uint256 tokenA, uint256 tokenB) external returns (uint256 newTokenId) {
        require(tokenA != tokenB, "token ids must be distinct");
        TokenInfo storage a = _requireAccessory(tokenA);
        TokenInfo storage b = _requireAccessory(tokenB);
        require(_owners[tokenA] == msg.sender && _owners[tokenB] == msg.sender, "not your tokens");
        _requireNotEquipped(tokenA);
        _requireNotEquipped(tokenB);
        require(!a.champion && !b.champion, "champion locked");
        require(a.rarity == b.rarity, "same rarity only");
        require(a.rarity < 3, "max rarity");
        uint8 newRarity = a.rarity + 1;
        uint8 newType;
        uint256 seed = _entropy(0xF05E);
        if (a.accType == b.accType) {
            newType = a.accType;
        } else {
            newType = uint8((seed >> 8) % 8);
        }
        uint32 stat = _bandRoll(newRarity, newType, seed >> 32);
        _burnRaw(tokenA);
        _burnRaw(tokenB);
        newTokenId = _mintRaw(
            msg.sender,
            TokenInfo({
                kind: KIND_ACCESSORY,
                accType: newType,
                rarity: newRarity,
                stat: stat,
                ocBonus: 0,
                serial: 0,
                champion: false,
                chassis: 0
            })
        );
        emit Fused(msg.sender, tokenA, tokenB, newTokenId, newType, newRarity);
    }

    // ----- Overclock -----

    /// @notice Max TOTAL overclock bonus per target rarity (in stat units;
    /// Core targets use HP units, i.e. these caps x5).
    function ocBonusCap(uint8 rarity) public pure returns (uint32) {
        if (rarity == 0) return 10;
        if (rarity == 1) return 20;
        if (rarity == 2) return 40;
        return 75;
    }

    /// @dev Bonus roll range by FUEL rarity: U 1-3, R 2-6, E 4-12, L 8-25.
    function _ocRoll(uint8 fuelRarity, uint256 seed) internal pure returns (uint32) {
        if (fuelRarity == 0) return 1 + uint32(seed % 3);
        if (fuelRarity == 1) return 2 + uint32(seed % 5);
        if (fuelRarity == 2) return 4 + uint32(seed % 9);
        return 8 + uint32(seed % 18);
    }

    /// @notice Burn a same-type accessory (the fuel) into a target
    /// accessory, raising its stat by a rolled bonus. The total bonus is
    /// hard-capped per target rarity; the roll is clamped at the cap.
    /// Neither part may be equipped. Champion legendaries cannot be fuel.
    function overclock(uint256 targetId, uint256 fuelId) external {
        require(targetId != fuelId, "token ids must be distinct");
        TokenInfo storage target = _requireAccessory(targetId);
        TokenInfo storage fuel = _requireAccessory(fuelId);
        require(_owners[targetId] == msg.sender && _owners[fuelId] == msg.sender, "not your tokens");
        _requireNotEquipped(targetId);
        _requireNotEquipped(fuelId);
        require(!fuel.champion, "champion locked");
        require(target.accType == fuel.accType, "same type only");
        uint32 capUnits = ocBonusCap(target.rarity) * (target.accType == 2 ? 5 : 1);
        require(target.ocBonus < capUnits, "overclock maxed");
        uint256 seed = _entropy(0x0C10C);
        uint32 rolled = _ocRoll(fuel.rarity, seed) * (target.accType == 2 ? 5 : 1);
        uint32 room = capUnits - target.ocBonus;
        uint32 added = rolled > room ? room : rolled;
        _burnRaw(fuelId);
        target.ocBonus += added;
        emit Overclocked(msg.sender, targetId, fuelId, added, target.ocBonus);
    }

    // ----- Equip -----

    /// @notice Equip an accessory into your Robot's slot for its type.
    /// One accessory per type; the slot must be empty.
    function equip(uint256 accessoryId) external {
        require(_hasRobot[msg.sender], "no robot");
        uint256 robotId = _robotOf[msg.sender];
        TokenInfo storage t = _requireAccessory(accessoryId);
        require(_owners[accessoryId] == msg.sender, "not your token");
        _requireNotEquipped(accessoryId);
        require(_equipped[robotId][t.accType] == 0, "slot already filled");
        _equipped[robotId][t.accType] = accessoryId + 1;
        _equippedIn[accessoryId] = robotId + 1;
        emit Equipped(msg.sender, robotId, accessoryId, t.accType);
    }

    /// @notice Remove the accessory in one of your Robot's slots.
    function unequip(uint8 accType) external returns (uint256 accessoryId) {
        require(accType < 8, "invalid type");
        require(_hasRobot[msg.sender], "no robot");
        uint256 robotId = _robotOf[msg.sender];
        uint256 packed = _equipped[robotId][accType];
        require(packed != 0, "slot is empty");
        accessoryId = packed - 1;
        _equipped[robotId][accType] = 0;
        _equippedIn[accessoryId] = 0;
        emit Unequipped(msg.sender, robotId, accessoryId, accType);
    }

    // ----- Loadout / fight stats -----

    /// @notice Effective stat of an accessory (rolled stat + overclock).
    function effectiveStat(uint256 tokenId) public view returns (uint32) {
        TokenInfo storage t = _requireAccessory(tokenId);
        return t.stat + t.ocBonus;
    }

    function _slotStat(uint256 robotId, uint8 accType) internal view returns (uint32) {
        uint256 packed = _equipped[robotId][accType];
        if (packed == 0) return 0;
        TokenInfo storage t = _tokens[packed - 1];
        return t.stat + t.ocBonus;
    }

    /// @dev Stats as an array: [hp, atk, def, acc, eva, crit, spd, luck].
    function _statsArr(uint256 robotId) internal view returns (uint32[8] memory s) {
        uint32 core = _slotStat(robotId, 2);
        s[0] = core > 0 ? core : uint32(BASE_HP);
        uint32 weapon = _slotStat(robotId, 3);
        s[1] = weapon > 0 ? weapon : uint32(BASE_ATK);
        s[2] = _slotStat(robotId, 0);
        s[3] = uint32(BASE_ACC) + _slotStat(robotId, 1);
        s[4] = _slotStat(robotId, 5);
        s[5] = _slotStat(robotId, 4);
        s[6] = _slotStat(robotId, 6);
        s[7] = _slotStat(robotId, 7);
    }

    /// @notice Fight stats for a robot: (hp, atk, def, acc, eva, crit, spd, luck).
    /// Empty slots fall back to base values (HP 50, ATK 5, ACC 50%).
    /// ACC/EVA/CRIT are percentages (capped in the fight engine).
    function fightStats(uint256 robotId)
        public
        view
        returns (uint32 hp, uint32 atk, uint32 def, uint32 acc, uint32 eva, uint32 crit, uint32 spd, uint32 luck)
    {
        require(_exists(robotId) && _tokens[robotId].kind == KIND_ROBOT, "not a robot");
        uint32[8] memory s = _statsArr(robotId);
        return (s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
    }

    /// @notice Comparable power score (HP counts at 1/5, like its band).
    function powerOf(uint256 robotId) public view returns (uint256) {
        uint32[8] memory s = _statsArr(robotId);
        return uint256(s[0] / 5) + s[1] + s[2] + s[3] + s[4] + s[5] + s[6] + s[7];
    }

    // ----- Duels -----

    function currentSeason() public view returns (uint256) {
        return (block.timestamp - seasonStart) / SEASON_LENGTH;
    }

    function _today() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice Create a challenge from your Robot. `opponentRobot` is only
    /// used when `open` is false (a named callout). Paid challenges escrow
    /// exactly 0.001 BNB, refunded if the challenge is cancelled.
    function createChallenge(uint256 opponentRobot, bool open, bool paid)
        external
        payable
        returns (uint256 challengeId)
    {
        require(_hasRobot[msg.sender], "no robot");
        uint256 myRobot = _robotOf[msg.sender];
        if (paid) {
            require(msg.value == DUEL_ENTRY, "entry is 0.001 BNB");
        } else {
            require(msg.value == 0, "free duel takes no value");
            require(_freeDuelsOnDay[myRobot][_today()] < MAX_FREE_DUELS_PER_DAY, "duel limit reached");
        }
        if (!open) {
            require(_exists(opponentRobot) && _tokens[opponentRobot].kind == KIND_ROBOT, "not a robot");
            require(opponentRobot != myRobot, "cannot challenge yourself");
        }
        challengeId = _challenges.length;
        _challenges.push(
            Challenge({
                challengerRobot: myRobot,
                opponentRobot: opponentRobot,
                challengerOwner: msg.sender,
                open: open,
                paid: paid,
                done: false
            })
        );
        emit ChallengeCreated(challengeId, myRobot, opponentRobot, open, paid);
    }

    /// @notice Cancel your own unaccepted challenge (escrow refunded).
    function cancelChallenge(uint256 challengeId) external {
        require(challengeId < _challenges.length, "no such challenge");
        Challenge storage c = _challenges[challengeId];
        require(!c.done, "challenge resolved");
        require(c.challengerOwner == msg.sender, "not your challenge");
        c.done = true;
        emit ChallengeCancelled(challengeId);
        if (c.paid) {
            (bool ok, ) = msg.sender.call{value: DUEL_ENTRY}("");
            require(ok, "escrow refund failed");
        }
    }

    /// @notice Accept a challenge with your Robot. The fight resolves in
    /// this same transaction. Paid accepts must send exactly 0.001 BNB.
    function acceptChallenge(uint256 challengeId) external payable {
        require(challengeId < _challenges.length, "no such challenge");
        Challenge storage c = _challenges[challengeId];
        require(!c.done, "challenge resolved");
        require(_hasRobot[msg.sender], "no robot");
        uint256 myRobot = _robotOf[msg.sender];
        require(myRobot != c.challengerRobot, "own challenge");
        if (!c.open) require(myRobot == c.opponentRobot, "not your challenge");
        if (c.paid) {
            require(msg.value == DUEL_ENTRY, "entry is 0.001 BNB");
        } else {
            require(msg.value == 0, "free duel takes no value");
            uint256 today = _today();
            require(_freeDuelsOnDay[myRobot][today] < MAX_FREE_DUELS_PER_DAY, "duel limit reached");
            require(
                _freeDuelsOnDay[c.challengerRobot][today] < MAX_FREE_DUELS_PER_DAY,
                "challenger duel limit"
            );
            _freeDuelsOnDay[myRobot][today] += 1;
            _freeDuelsOnDay[c.challengerRobot][today] += 1;
        }
        c.done = true;
        _resolveDuel(challengeId, c.challengerRobot, myRobot, c.paid);
    }

    /// @dev One strike: attacker stats array A vs defender stats array D
    /// (layout [hp, atk, def, acc, eva, crit, spd, luck]).
    function _strike(uint256 seed, uint256 round, uint256 turn, uint32[8] memory A, uint32[8] memory D)
        internal
        pure
        returns (uint256 damage)
    {
        uint256 roll = uint256(keccak256(abi.encodePacked(seed, round, turn, "hit"))) % 100;
        uint256 hitChance = A[3] > D[4] ? A[3] - D[4] : 10;
        if (hitChance < 10) hitChance = 10;
        if (hitChance > 95) hitChance = 95;
        if (roll >= hitChance) return 0;
        uint256 dmg = (uint256(A[1]) * 100) / (100 + uint256(D[2]));
        if (dmg == 0) dmg = 1;
        uint256 critRoll = uint256(keccak256(abi.encodePacked(seed, round, turn, "crit"))) % 100;
        if (critRoll < A[5]) dmg *= 2;
        uint256 swing = uint256(keccak256(abi.encodePacked(seed, round, turn, "luck"))) % (uint256(A[7]) + 1);
        dmg += (dmg * swing) / 400; // LUCK: up to +25%
        return dmg;
    }

    function _clamp(uint32[8] memory s) internal pure {
        if (s[3] > 95) s[3] = 95; // ACC
        if (s[4] > 60) s[4] = 60; // EVA
        if (s[5] > 75) s[5] = 75; // CRIT
    }

    /// @dev Round-by-round fight. SPD strikes first; ~20 rounds; then the
    /// robot with more remaining HP wins (ties: more power, then defender).
    function _fight(uint256 seed, uint256 robotA, uint256 robotB) internal view returns (uint256 winner, uint256 loser) {
        uint32[8] memory A = _statsArr(robotA);
        uint32[8] memory B = _statsArr(robotB);
        _clamp(A);
        _clamp(B);
        uint256 remA = A[0];
        uint256 remB = B[0];
        bool aFirst = A[6] >= B[6];
        for (uint256 round = 0; round < 20 && remA > 0 && remB > 0; round++) {
            for (uint256 turn = 0; turn < 2 && remA > 0 && remB > 0; turn++) {
                if ((turn == 0) == aFirst) {
                    uint256 d = _strike(seed, round, turn, A, B);
                    remB = d >= remB ? 0 : remB - d;
                } else {
                    uint256 d = _strike(seed, round, turn, B, A);
                    remA = d >= remA ? 0 : remA - d;
                }
            }
        }
        if (remA != remB) {
            winner = remA > remB ? robotA : robotB;
        } else if (powerOf(robotA) != powerOf(robotB)) {
            winner = powerOf(robotA) > powerOf(robotB) ? robotA : robotB;
        } else {
            winner = robotB; // defender wins a perfect tie
        }
        loser = winner == robotA ? robotB : robotA;
    }

    function _awardPoints(uint256 winnerRobot, uint256 loserRobot) internal returns (uint256 points) {
        points = 10;
        uint256 wPower = powerOf(winnerRobot);
        uint256 lPower = powerOf(loserRobot);
        if (lPower > wPower) {
            uint256 bonus = (lPower - wPower) / 5;
            points += bonus > 20 ? 20 : bonus;
        }
        _streak[winnerRobot] += 1;
        if (_streak[winnerRobot] >= 3) points *= 2;
        _streak[loserRobot] = 0;
        uint256 season = currentSeason();
        if (!_scoredInSeason[winnerRobot][season]) {
            _scoredInSeason[winnerRobot][season] = true;
            _seasonRobots[season].push(winnerRobot);
        }
        _points[winnerRobot][season] += points;
    }

    function _resolveDuel(uint256 challengeId, uint256 challengerRobot, uint256 acceptorRobot, bool paid) internal {
        uint256 seed = _entropy(0xD0E1 + challengeId);
        (uint256 winner, uint256 loser) = _fight(seed, challengerRobot, acceptorRobot);
        _wins[winner] += 1;
        _losses[loser] += 1;
        uint256 points = _awardPoints(winner, loser);
        address winnerOwner = _owners[winner];
        uint256 potPaid = 0;
        uint256 bountyPaid = 0;
        if (paid) {
            uint256 pot = DUEL_ENTRY * 2;
            uint256 winnerShare = (pot * 90) / 100;
            uint256 poolCut = (pot * 5) / 100;
            uint256 creatorCutAmt = pot - winnerShare - poolCut;
            _pool += poolCut;
            potPaid = winnerShare;
            // Bounties on the LOSER are claimed by the winner, in full.
            uint256[] storage ids = _bountiesOn[loser];
            for (uint256 i = 0; i < ids.length; i++) {
                Bounty storage b = _bounties[ids[i]];
                if (b.active) {
                    b.active = false;
                    bountyPaid += b.amount;
                    emit BountyClaimed(ids[i], winnerOwner, b.amount);
                }
            }
            (bool ok1, ) = winnerOwner.call{value: winnerShare + bountyPaid}("");
            require(ok1, "payout failed");
            (bool ok2, ) = creator.call{value: creatorCutAmt}("");
            require(ok2, "creator cut transfer failed");
        }
        emit DuelResolved(challengeId, winner, loser, winnerOwner, points, potPaid, bountyPaid);
    }

    // ----- Bounty board -----

    /// @notice Escrow BNB as a bounty on a rival Robot. The first paid-duel
    /// winner against that Robot claims it in full.
    function postBounty(uint256 robotId) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "bounty needs value");
        require(_exists(robotId) && _tokens[robotId].kind == KIND_ROBOT, "not a robot");
        bountyId = _bounties.length;
        _bounties.push(
            Bounty({poster: msg.sender, robotId: robotId, amount: msg.value, createdAt: block.timestamp, active: true})
        );
        _bountiesOn[robotId].push(bountyId);
        emit BountyPosted(bountyId, msg.sender, robotId, msg.value);
    }

    /// @notice Reclaim your bounty after 7 days unclaimed.
    function reclaimBounty(uint256 bountyId) external {
        require(bountyId < _bounties.length, "no such bounty");
        Bounty storage b = _bounties[bountyId];
        require(b.active, "bounty not active");
        require(b.poster == msg.sender, "not your bounty");
        require(block.timestamp >= b.createdAt + BOUNTY_RECLAIM_DELAY, "too early to reclaim");
        b.active = false;
        emit BountyReclaimed(bountyId, msg.sender, b.amount);
        (bool ok, ) = msg.sender.call{value: b.amount}("");
        require(ok, "reclaim transfer failed");
    }

    // ----- Seasons -----

    /// @notice Settle a finished season. Callable by anyone once the season
    /// has ended. Pays 50% of the pool to the season's Top 20 (rank
    /// weights 21-rank over a fixed total of 210; unfilled ranks keep
    /// their share in the pool) and awards 3 prize-vault Legendaries by
    /// equal-chance lottery among the Top 20 (fewer if the vault or the
    /// leaderboard is smaller).
    function settleSeason(uint256 season) external {
        require(season < currentSeason(), "season not finished");
        require(!_seasonSettled[season], "season already settled");
        _seasonSettled[season] = true;
        uint256[] storage robots = _seasonRobots[season];
        uint256 n = robots.length;
        // Select Top 20 by points (selection passes over the scorers list).
        uint256 topCount = n > 20 ? 20 : n;
        uint256[] memory top = new uint256[](topCount);
        bool[] memory used = new bool[](n);
        for (uint256 r = 0; r < topCount; r++) {
            uint256 best = type(uint256).max;
            for (uint256 i = 0; i < n; i++) {
                if (used[i]) continue;
                if (best == type(uint256).max || _points[robots[i]][season] > _points[robots[best]][season]) {
                    best = i;
                }
            }
            used[best] = true;
            top[r] = robots[best];
        }
        uint256 poolHalf = _pool / 2;
        uint256 paidTotal = 0;
        for (uint256 r = 0; r < topCount; r++) {
            uint256 share = (poolHalf * (21 - r)) / 210;
            if (share == 0) continue;
            paidTotal += share;
            (bool ok, ) = _owners[top[r]].call{value: share}("");
            require(ok, "payout failed");
        }
        _pool -= paidTotal;
        _totalPoolPaidOut += paidTotal;
        // Legendary lottery: 3 distinct winners, equal chance among Top 20.
        uint256 prizes = LOTTERY_PRIZES_PER_SEASON;
        uint256 remaining = _vaultIds.length - _vaultCursor;
        if (prizes > remaining) prizes = remaining;
        if (prizes > topCount) prizes = topCount;
        if (prizes > 0) {
            uint256 seed = _entropy(0x1077E21 + season);
            bool[] memory won = new bool[](topCount);
            for (uint256 p = 0; p < prizes; p++) {
                uint256 idx = uint256(keccak256(abi.encodePacked(seed, p))) % topCount;
                while (won[idx]) idx = (idx + 1) % topCount;
                won[idx] = true;
                uint256 tokenId = _vaultIds[_vaultCursor];
                _vaultCursor += 1;
                address winnerAddr = _owners[top[idx]];
                _transferRaw(address(this), winnerAddr, tokenId);
                emit LotteryWon(season, top[idx], winnerAddr, tokenId, _tokens[tokenId].serial);
            }
        }
        emit SeasonSettled(season, paidTotal, topCount);
    }

    // ----- Views -----

    function robotOf(address user) external view returns (uint256 robotId, bool has) {
        return (_robotOf[user], _hasRobot[user]);
    }

    function drawnPerType(uint8 accType) external view returns (uint256) {
        require(accType < 8, "invalid type");
        return _drawnPerType[accType];
    }

    function totalDrawn() external view returns (uint256 total) {
        for (uint8 i = 0; i < 8; i++) total += _drawnPerType[i];
    }

    function rewardPool() external view returns (uint256) {
        return _pool;
    }

    function totalPoolPaidOut() external view returns (uint256) {
        return _totalPoolPaidOut;
    }

    function vaultRemaining() external view returns (uint256) {
        return _vaultIds.length - _vaultCursor;
    }

    /// @notice The next Champion-Edition Legendaries waiting in the vault.
    function vaultPreview(uint256 count) external view returns (uint256[] memory tokenIds) {
        uint256 remaining = _vaultIds.length - _vaultCursor;
        if (count > remaining) count = remaining;
        tokenIds = new uint256[](count);
        for (uint256 i = 0; i < count; i++) tokenIds[i] = _vaultIds[_vaultCursor + i];
    }

    function tokenInfo(uint256 tokenId)
        external
        view
        returns (
            uint8 kind, uint8 accType, uint8 rarity, uint32 stat, uint32 ocBonus,
            uint32 serial, bool champion, uint16 chassis, bool equipped
        )
    {
        require(_exists(tokenId), "token does not exist");
        TokenInfo storage t = _tokens[tokenId];
        return (t.kind, t.accType, t.rarity, t.stat, t.ocBonus, t.serial, t.champion, t.chassis, _equippedIn[tokenId] != 0);
    }

    /// @notice Champion-Edition name for a prize-vault Legendary ("" otherwise).
    function championName(uint256 tokenId) external view returns (string memory) {
        require(_exists(tokenId), "token does not exist");
        TokenInfo storage t = _tokens[tokenId];
        if (!t.champion || t.serial == 0 || t.serial > _ceNames.length) return "";
        return _ceNames[t.serial - 1];
    }

    /// @notice Accessory token id equipped in a robot's slot (type), or the
    /// max uint256 when the slot is empty.
    function equippedInSlot(uint256 robotId, uint8 accType) external view returns (uint256) {
        uint256 packed = _equipped[robotId][accType];
        return packed == 0 ? type(uint256).max : packed - 1;
    }

    function recordOf(uint256 robotId) external view returns (uint256 wins, uint256 losses, uint256 streak) {
        return (_wins[robotId], _losses[robotId], _streak[robotId]);
    }

    function pointsOf(uint256 robotId, uint256 season) external view returns (uint256) {
        return _points[robotId][season];
    }

    function seasonScorerCount(uint256 season) external view returns (uint256) {
        return _seasonRobots[season].length;
    }

    function seasonSettled(uint256 season) external view returns (bool) {
        return _seasonSettled[season];
    }

    function challengeInfo(uint256 challengeId)
        external
        view
        returns (uint256 challengerRobot, uint256 opponentRobot, bool open, bool paid, bool done)
    {
        require(challengeId < _challenges.length, "no such challenge");
        Challenge storage c = _challenges[challengeId];
        return (c.challengerRobot, c.opponentRobot, c.open, c.paid, c.done);
    }

    function bountyInfo(uint256 bountyId)
        external
        view
        returns (address poster, uint256 robotId, uint256 amount, uint256 createdAt, bool active)
    {
        require(bountyId < _bounties.length, "no such bounty");
        Bounty storage b = _bounties[bountyId];
        return (b.poster, b.robotId, b.amount, b.createdAt, b.active);
    }

    function paidDrawsToday(address user) external view returns (uint256) {
        return _paidDrawsOnDay[user][_today()];
    }

    function freeDuelsToday(uint256 robotId) external view returns (uint256) {
        return _freeDuelsOnDay[robotId][_today()];
    }

    function totalMinted() external view returns (uint256) {
        return _tokens.length;
    }

    function robotCount() external view returns (uint256) {
        return _robotCount;
    }

    function typeName(uint8 accType) public pure returns (string memory) {
        string[8] memory names_ = ["Helmet", "Visor", "Core", "Weapon", "Arms", "Jetpack", "Legs", "Drone"];
        require(accType < 8, "invalid type");
        return names_[accType];
    }

    function statName(uint8 accType) public pure returns (string memory) {
        string[8] memory names_ = ["DEF", "ACC", "HP", "ATK", "CRIT", "EVA", "SPD", "LUCK"];
        require(accType < 8, "invalid type");
        return names_[accType];
    }

    function rarityName(uint8 rarity) public pure returns (string memory) {
        if (rarity == 0) return "Uncommon";
        if (rarity == 1) return "Rare";
        if (rarity == 2) return "Epic";
        if (rarity == 3) return "Legendary";
        revert("invalid rarity");
    }

    // ----- ERC-721 -----

    function balanceOf(address owner_) external view returns (uint256) {
        require(owner_ != address(0), "zero address");
        return _balances[owner_];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        require(_exists(tokenId), "token does not exist");
        return _owners[tokenId];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(_exists(tokenId), "token does not exist");
        require(_tokens[tokenId].kind != KIND_ROBOT, "robots are soulbound");
        _requireNotEquipped(tokenId);
        require(_owners[tokenId] == from, "from is not the owner");
        require(to != address(0), "transfer to zero address");
        require(
            msg.sender == from || msg.sender == _tokenApprovals[tokenId] || _operatorApprovals[from][msg.sender],
            "not owner or approved"
        );
        _transferRaw(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        require(_checkOnERC721Received(from, to, tokenId, data), "non-ERC721 receiver");
    }

    function _checkOnERC721Received(address from, address to, uint256 tokenId, bytes memory data)
        internal
        returns (bool)
    {
        if (to.code.length == 0) return true;
        (bool ok, bytes memory ret) = to.call(abi.encodeWithSelector(0x150b7a5e, msg.sender, from, tokenId, data));
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (bytes4)) == bytes4(0x150b7a5e);
    }

    function approve(address approved, uint256 tokenId) external {
        require(_exists(tokenId), "token does not exist");
        require(_tokens[tokenId].kind != KIND_ROBOT, "robots are soulbound");
        _requireNotEquipped(tokenId);
        address o = _owners[tokenId];
        require(msg.sender == o || _operatorApprovals[o][msg.sender], "not owner or operator");
        _tokenApprovals[tokenId] = approved;
        emit Approval(o, approved, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        require(_exists(tokenId), "token does not exist");
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner_, address operator) external view returns (bool) {
        return _operatorApprovals[owner_][operator];
    }

    // ----- ERC-2981 royalties -----

    /// @notice 5% royalty on every token, paid to the creator (owner()).
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount)
    {
        require(_exists(tokenId), "token does not exist");
        return (creator, (salePrice * ROYALTY_BPS) / 10000);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC165
            interfaceId == 0x80ac58cd || // ERC721
            interfaceId == 0x5b5e139f || // ERC721Metadata
            interfaceId == 0x2a55205a || // ERC2981
            interfaceId == 0x7f5828d0; // ERC173 (owner())
    }

    // ----- Metadata -----

    string internal constant _DESC =
        "Agent X Robot on BNB Chain: your Agent ID's fighter. Draw parts, fuse and overclock them, equip your robot and duel other agents. The owner cannot withdraw the pool or change the rules.";

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_exists(tokenId), "token does not exist");
        if (bytes(_baseURI).length > 0) {
            return string(abi.encodePacked(_baseURI, _toString(tokenId)));
        }
        return string(abi.encodePacked("data:application/json;base64,", _base64Encode(bytes(_tokenJSON(_tokens[tokenId])))));
    }

    function _tokenJSON(TokenInfo storage t) internal view returns (string memory) {
        if (t.kind == KIND_ROBOT) {
            return string(
                abi.encodePacked(
                    '{"name":"Agent X Robot #', _toString(t.serial),
                    '","description":"', _DESC,
                    '","attributes":[{"trait_type":"Kind","value":"Robot"},',
                    '{"trait_type":"Chassis","value":', _toString(t.chassis), "}]}"
                )
            );
        }
        string memory nm = string(
            abi.encodePacked("AXR ", typeName(t.accType), " - ", rarityName(t.rarity))
        );
        if (t.champion) {
            nm = string(
                abi.encodePacked(
                    "CE-", _pad2(t.serial), " ", _ceNames[t.serial - 1], " (", typeName(t.accType), ")"
                )
            );
        }
        return string(
            abi.encodePacked(
                '{"name":"', nm,
                '","description":"', _DESC,
                '","attributes":[{"trait_type":"Kind","value":"Accessory"},',
                '{"trait_type":"Type","value":"', typeName(t.accType), '"},',
                '{"trait_type":"Stat","value":"', statName(t.accType), '"},',
                '{"trait_type":"Rarity","value":"', rarityName(t.rarity), '"},',
                '{"trait_type":"Stat Value","value":', _toString(t.stat), "},",
                '{"trait_type":"Overclock","value":', _toString(t.ocBonus), "},",
                '{"trait_type":"Champion Edition","value":"', t.champion ? "Yes" : "No", '"}]}'
            )
        );
    }

    function _pad2(uint32 v) internal pure returns (string memory) {
        if (v < 10) return string(abi.encodePacked("0", _toString(v)));
        return _toString(v);
    }

    // ----- String helpers -----

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _base64Encode(bytes memory data) internal pure returns (string memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        uint256 len = data.length;
        if (len == 0) return "";
        bytes memory result = new bytes(4 * ((len + 2) / 3));
        uint256 i;
        uint256 j;
        while (i < len) {
            uint256 a = uint8(data[i]);
            uint256 b = i + 1 < len ? uint8(data[i + 1]) : 0;
            uint256 c = i + 2 < len ? uint8(data[i + 2]) : 0;
            result[j] = table[(a >> 2) & 0x3f];
            result[j + 1] = table[((a & 0x03) << 4) | (b >> 4)];
            result[j + 2] = i + 1 < len ? table[((b & 0x0f) << 2) | (c >> 6)] : bytes1("=");
            result[j + 3] = i + 2 < len ? table[c & 0x3f] : bytes1("=");
            i += 3;
            j += 4;
        }
        return string(result);
    }

    // ----- Test-only surface (never callable on AgentXRobot itself) -----

    /// @dev Internal setters used ONLY by the local AXRTestHarness subclass
    /// to stage deterministic unit tests (supply-cap and fusion states that
    /// would take ~20,000 random draws to reach organically). AgentXRobot
    /// as deployed has no external path to these.
    function _testSetDrawnPerType(uint8 accType, uint256 n) internal {
        _drawnPerType[accType] = n;
    }
}
