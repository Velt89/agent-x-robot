const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 86400;
const DRAW_PRICE = ethers.parseEther("0.001");
const POOL_PER_DRAW = ethers.parseEther("0.00095");
const CREATOR_PER_DRAW = ethers.parseEther("0.00005");

// accessory types: 0 Helmet DEF, 1 Visor ACC, 2 Core HP, 3 Weapon ATK, 4 Arms CRIT, 5 Jetpack EVA, 6 Legs SPD, 7 Drone LUCK
const BANDS = [[1, 10], [11, 25], [26, 50], [51, 100]];

async function deploy(useHarness = true) {
  const latest = await time.latest();
  await time.setNextBlockTimestamp((Math.floor(latest / DAY) + 1) * DAY + 3600);
  const signers = await ethers.getSigners();
  const [creator, alice, bob, carol, dave, erin, frank, grace] = signers;
  const Mock = await ethers.getContractFactory("MockAgentID");
  const mock = await Mock.deploy();
  const F = await ethers.getContractFactory(useHarness ? "AXRTestHarness" : "AgentXRobot");
  const axr = await F.deploy(await mock.getAddress());
  for (const u of [alice, bob, carol, erin, frank, grace]) await mock.setHolder(u.address, true);
  // dave: no Agent ID. creator: deployer/owner, not a holder.
  return { axr, mock, creator, alice, bob, carol, dave, erin, frank, grace };
}

function findEvent(axr, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const p = axr.interface.parseLog(log);
      if (p && p.name === name) return p.args;
    } catch { /* not ours */ }
  }
  throw new Error("event not found: " + name);
}

async function mintRobot(axr, user) {
  const tx = await axr.connect(user).mintRobot();
  const rc = await tx.wait();
  const e = findEvent(axr, rc, "RobotMinted");
  return { robotId: e.robotId, accessoryId: e.accessoryId };
}

async function drawPaid(axr, user) {
  const tx = await axr.connect(user).drawAccessory({ value: DRAW_PRICE });
  const rc = await tx.wait();
  return findEvent(axr, rc, "AccessoryDrawn").tokenId;
}

async function nextDay() { await time.increase(DAY); }

/** Run a free duel: challenger creates an open challenge, acceptor accepts. Returns DuelResolved args. */
async function freeDuel(axr, challenger, acceptor) {
  const tx1 = await axr.connect(challenger).createChallenge(0, true, false);
  const rc1 = await tx1.wait();
  const cid = findEvent(axr, rc1, "ChallengeCreated").challengeId;
  const tx2 = await axr.connect(acceptor).acceptChallenge(cid);
  const rc2 = await tx2.wait();
  return findEvent(axr, rc2, "DuelResolved");
}

/** Run a paid duel (both sides escrow). Returns DuelResolved args. */
async function paidDuel(axr, challenger, acceptor) {
  const tx1 = await axr.connect(challenger).createChallenge(0, true, true, { value: DRAW_PRICE });
  const rc1 = await tx1.wait();
  const cid = findEvent(axr, rc1, "ChallengeCreated").challengeId;
  const tx2 = await axr.connect(acceptor).acceptChallenge(cid, { value: DRAW_PRICE });
  const rc2 = await tx2.wait();
  return findEvent(axr, rc2, "DuelResolved");
}

/** Give `user` a debug part and equip it. Returns token id. */
async function equipPart(axr, user, type, rarity, stat) {
  const id = await axr.debugMintAccessory.staticCall(user.address, type, rarity, stat);
  await axr.debugMintAccessory(user.address, type, rarity, stat);
  await axr.connect(user).equip(id);
  return id;
}

describe("AgentXRobot", function () {
  this.timeout(300000);

  describe("free mint gating", function () {
    it("reverts for non Agent ID holders", async function () {
      const { axr, dave } = await deploy();
      await expect(axr.connect(dave).mintRobot()).to.be.revertedWith("no Agent ID");
    });

    it("mints a soulbound robot + one accessory, once only", async function () {
      const { axr, alice } = await deploy();
      const { robotId, accessoryId } = await mintRobot(axr, alice);
      expect(await axr.balanceOf(alice.address)).to.equal(2);
      expect(await axr.ownerOf(robotId)).to.equal(alice.address);
      const r = await axr.tokenInfo(robotId);
      expect(r.kind).to.equal(0);
      const a = await axr.tokenInfo(accessoryId);
      expect(a.kind).to.equal(1);
      expect(a.rarity).to.be.lessThanOrEqual(2); // free draw: never Legendary
      const [lo, hi] = BANDS[Number(a.rarity)];
      const mult = Number(a.accType) === 2 ? 5 : 1;
      expect(a.stat).to.be.within(lo * mult, hi * mult);
      const [rid, has] = await axr.robotOf(alice.address);
      expect(has).to.equal(true);
      expect(rid).to.equal(robotId);
      await expect(axr.connect(alice).mintRobot()).to.be.revertedWith("robot already minted");
    });
  });

  describe("prize vault (production contract)", function () {
    it("holds 50 named Champion-Edition Legendaries at deploy", async function () {
      const { axr } = await deploy(false);
      expect(await axr.vaultRemaining()).to.equal(50);
      expect(await axr.balanceOf(await axr.getAddress())).to.equal(50);
      const ids = await axr.vaultPreview(50);
      expect(ids.length).to.equal(50);
      const serials = new Set();
      for (const id of ids) {
        const t = await axr.tokenInfo(id);
        expect(t.champion).to.equal(true);
        expect(t.rarity).to.equal(3);
        serials.add(Number(t.serial));
        const mult = Number(t.accType) === 2 ? 5 : 1;
        expect(t.stat).to.be.within(51 * mult, 100 * mult);
        expect(await axr.championName(id)).to.not.equal("");
      }
      expect(serials.size).to.equal(50);
    });
  });

  describe("paid draw", function () {
    it("requires a robot and the exact price", async function () {
      const { axr, alice, bob } = await deploy();
      await expect(axr.connect(bob).drawAccessory({ value: DRAW_PRICE })).to.be.revertedWith("no robot");
      await mintRobot(axr, alice);
      await expect(axr.connect(alice).drawAccessory({ value: ethers.parseEther("0.002") }))
        .to.be.revertedWith("price is 0.001 BNB");
    });

    it("splits 95% pool / 5% creator and enforces 2/day", async function () {
      const { axr, creator, alice } = await deploy();
      await mintRobot(axr, alice);
      const tx = await axr.connect(alice).drawAccessory({ value: DRAW_PRICE });
      await expect(tx).to.changeEtherBalances(
        [creator, await axr.getAddress()],
        [CREATOR_PER_DRAW, POOL_PER_DRAW]
      );
      expect(await axr.rewardPool()).to.equal(POOL_PER_DRAW);
      await drawPaid(axr, alice);
      expect(await axr.rewardPool()).to.equal(POOL_PER_DRAW * 2n);
      await expect(axr.connect(alice).drawAccessory({ value: DRAW_PRICE }))
        .to.be.revertedWith("draw limit reached");
      await nextDay();
      await drawPaid(axr, alice); // works again tomorrow
      expect(await axr.paidDrawsToday(alice.address)).to.equal(1);
    });
  });

  describe("draw supply cap", function () {
    it("reverts when every type is at cap", async function () {
      const { axr, alice } = await deploy();
      await mintRobot(axr, alice);
      for (let t = 0; t < 8; t++) await axr.debugSetDrawnPerType(t, 2500);
      await expect(axr.connect(alice).drawAccessory({ value: DRAW_PRICE }))
        .to.be.revertedWith("supply exhausted");
    });

    it("never draws a capped type (scans to the next type)", async function () {
      const { axr, alice } = await deploy();
      await mintRobot(axr, alice);
      await axr.debugSetDrawnPerType(3, 2500); // Weapon capped
      for (let d = 0; d < 10; d++) {
        for (let k = 0; k < 2; k++) {
          const id = await drawPaid(axr, alice);
          const t = await axr.tokenInfo(id);
          expect(Number(t.accType)).to.not.equal(3);
        }
        await nextDay();
      }
      expect(await axr.drawnPerType(3)).to.equal(2500);
    });
  });

  describe("fusion", function () {
    it("same type -> same type, next rarity; inputs burned", async function () {
      const { axr, alice } = await deploy();
      await mintRobot(axr, alice);
      const a = await axr.debugMintAccessory.staticCall(alice.address, 0, 0, 5);
      await axr.debugMintAccessory(alice.address, 0, 0, 5);
      const b = await axr.debugMintAccessory.staticCall(alice.address, 0, 0, 7);
      await axr.debugMintAccessory(alice.address, 0, 0, 7);
      const balBefore = await axr.balanceOf(alice.address);
      const tx = await axr.connect(alice).fuse(a, b);
      const rc = await tx.wait();
      const e = findEvent(axr, rc, "Fused");
      const t = await axr.tokenInfo(e.newTokenId);
      expect(Number(t.accType)).to.equal(0);
      expect(Number(t.rarity)).to.equal(1);
      expect(t.stat).to.be.within(11, 25);
      expect(await axr.balanceOf(alice.address)).to.equal(balBefore - 1n);
      await expect(axr.ownerOf(a)).to.be.revertedWith("token does not exist");
    });

    it("mixed types -> random type, next rarity", async function () {
      const { axr, alice } = await deploy();
      await mintRobot(axr, alice);
      const a = await axr.debugMintAccessory.staticCall(alice.address, 1, 0, 5);
      await axr.debugMintAccessory(alice.address, 1, 0, 5);
      const b = await axr.debugMintAccessory.staticCall(alice.address, 6, 0, 5);
      await axr.debugMintAccessory(alice.address, 6, 0, 5);
      const tx = await axr.connect(alice).fuse(a, b);
      const rc = await tx.wait();
      const e = findEvent(axr, rc, "Fused");
      expect(Number(e.rarity)).to.equal(1);
      expect(Number(e.accType)).to.be.within(0, 7);
    });

    it("epic pair fuses to legendary; legendary pair and mixed rarities revert", async function () {
      const { axr, alice } = await deploy();
      await mintRobot(axr, alice);
      const m = async (type, rarity, stat) => {
        const id = await axr.debugMintAccessory.staticCall(alice.address, type, rarity, stat);
        await axr.debugMintAccessory(alice.address, type, rarity, stat);
        return id;
      };
      const e1 = await m(3, 2, 40), e2 = await m(3, 2, 44);
      const tx = await axr.connect(alice).fuse(e1, e2);
      const rc = await tx.wait();
      expect(Number(findEvent(axr, rc, "Fused").rarity)).to.equal(3);
      const l1 = await m(3, 3, 80), l2 = await m(3, 3, 90);
      await expect(axr.connect(alice).fuse(l1, l2)).to.be.revertedWith("max rarity");
      const u1 = await m(0, 0, 5);
      await expect(axr.connect(alice).fuse(u1, l1)).to.be.revertedWith("same rarity only");
    });
  });

  describe("overclock", function () {
    it("burns fuel into the target and clamps at the rarity cap", async function () {
      const { axr, alice } = await deploy();
      await mintRobot(axr, alice);
      const target = await axr.debugMintAccessory.staticCall(alice.address, 3, 0, 5);
      await axr.debugMintAccessory(alice.address, 3, 0, 5); // Uncommon Weapon, cap = 10
      let maxed = false;
      for (let i = 0; i < 6 && !maxed; i++) {
        const fuel = await axr.debugMintAccessory.staticCall(alice.address, 3, 3, 90);
        await axr.debugMintAccessory(alice.address, 3, 3, 90); // Legendary fuel
        try {
          await axr.connect(alice).overclock(target, fuel);
        } catch (e) {
          expect(String(e.message)).to.include("overclock maxed");
          maxed = true;
        }
      }
      const t = await axr.tokenInfo(target);
      expect(t.ocBonus).to.equal(10); // Uncommon cap reached exactly
      expect(await axr.effectiveStat(target)).to.equal(15);
      const fuel = await axr.debugMintAccessory.staticCall(alice.address, 3, 3, 90);
      await axr.debugMintAccessory(alice.address, 3, 3, 90);
      await expect(axr.connect(alice).overclock(target, fuel)).to.be.revertedWith("overclock maxed");
    });

    it("rejects different-type fuel", async function () {
      const { axr, alice } = await deploy();
      await mintRobot(axr, alice);
      const target = await axr.debugMintAccessory.staticCall(alice.address, 3, 0, 5);
      await axr.debugMintAccessory(alice.address, 3, 0, 5);
      const fuel = await axr.debugMintAccessory.staticCall(alice.address, 0, 0, 5);
      await axr.debugMintAccessory(alice.address, 0, 0, 5);
      await expect(axr.connect(alice).overclock(target, fuel)).to.be.revertedWith("same type only");
    });
  });

  describe("equip + soulbound", function () {
    it("robots never transfer; accessories do; equipped parts are locked", async function () {
      const { axr, alice, bob } = await deploy();
      const { robotId, accessoryId } = await mintRobot(axr, alice);
      await expect(axr.connect(alice).transferFrom(alice.address, bob.address, robotId))
        .to.be.revertedWith("robots are soulbound");
      // plain accessory transfer works
      await axr.connect(alice).transferFrom(alice.address, bob.address, accessoryId);
      expect(await axr.ownerOf(accessoryId)).to.equal(bob.address);
      // equip locks the part
      const w = await axr.debugMintAccessory.staticCall(alice.address, 3, 1, 20);
      await axr.debugMintAccessory(alice.address, 3, 1, 20);
      await axr.connect(alice).equip(w);
      expect(await axr.equippedInSlot(robotId, 3)).to.equal(w);
      await expect(axr.connect(alice).transferFrom(alice.address, bob.address, w))
        .to.be.revertedWith("unequip it first");
      const w2 = await axr.debugMintAccessory.staticCall(alice.address, 3, 0, 5);
      await axr.debugMintAccessory(alice.address, 3, 0, 5);
      await expect(axr.connect(alice).fuse(w, w2)).to.be.revertedWith("unequip it first");
      await expect(axr.connect(alice).equip(w2)).to.be.revertedWith("slot already filled");
      await axr.connect(alice).unequip(3);
      await axr.connect(alice).transferFrom(alice.address, bob.address, w);
      expect(await axr.ownerOf(w)).to.equal(bob.address);
    });
  });

  describe("duels", function () {
    it("free duels: points to the winner, 3/day limit per robot", async function () {
      const { axr, alice, bob, carol } = await deploy();
      const A = await mintRobot(axr, alice);
      const B = await mintRobot(axr, bob);
      await mintRobot(axr, carol);
      const res = await freeDuel(axr, alice, bob);
      const winner = Number(res.winnerRobot);
      expect([Number(A.robotId), Number(B.robotId)]).to.include(winner);
      expect(await axr.pointsOf(winner, 0)).to.be.greaterThan(0);
      const rec = await axr.recordOf(winner);
      expect(rec.wins).to.equal(1);
      // burn alice's remaining free duels against carol (2 more), 4th create reverts
      await freeDuel(axr, alice, carol);
      await freeDuel(axr, alice, carol);
      await expect(axr.connect(alice).createChallenge(0, true, false))
        .to.be.revertedWith("duel limit reached");
    });

    it("named challenges can only be accepted by the named robot", async function () {
      const { axr, alice, bob, carol } = await deploy();
      await mintRobot(axr, alice);
      const B = await mintRobot(axr, bob);
      await mintRobot(axr, carol);
      const tx = await axr.connect(alice).createChallenge(B.robotId, false, false);
      const rc = await tx.wait();
      const cid = findEvent(axr, rc, "ChallengeCreated").challengeId;
      await expect(axr.connect(carol).acceptChallenge(cid)).to.be.revertedWith("not your challenge");
      await expect(axr.connect(alice).acceptChallenge(cid)).to.be.revertedWith("own challenge");
      await axr.connect(bob).acceptChallenge(cid); // works
    });

    it("paid duel: pot splits 90% winner / 5% pool / 5% creator", async function () {
      const { axr, creator, alice, bob } = await deploy();
      const A = await mintRobot(axr, alice);
      await mintRobot(axr, bob);
      await equipPart(axr, alice, 3, 3, 100); // Legendary Weapon ATK 100
      await equipPart(axr, alice, 2, 3, 500); // Legendary Core HP 500
      const poolBefore = await axr.rewardPool();
      const tx1 = await axr.connect(alice).createChallenge(0, true, true, { value: DRAW_PRICE });
      const rc1 = await tx1.wait();
      const cid = findEvent(axr, rc1, "ChallengeCreated").challengeId;
      const tx2 = await axr.connect(bob).acceptChallenge(cid, { value: DRAW_PRICE });
      const rc2 = await tx2.wait();
      const res = findEvent(axr, rc2, "DuelResolved");
      expect(Number(res.winnerRobot)).to.equal(Number(A.robotId));
      await expect(tx2).to.changeEtherBalances(
        [alice, creator],
        [ethers.parseEther("0.0018"), ethers.parseEther("0.0001")]
      );
      expect(await axr.rewardPool()).to.equal(poolBefore + ethers.parseEther("0.0001"));
      expect(res.potPaid).to.equal(ethers.parseEther("0.0018"));
    });

    it("cancelled paid challenge refunds the escrow", async function () {
      const { axr, alice } = await deploy();
      await mintRobot(axr, alice);
      const tx1 = await axr.connect(alice).createChallenge(0, true, true, { value: DRAW_PRICE });
      const rc1 = await tx1.wait();
      const cid = findEvent(axr, rc1, "ChallengeCreated").challengeId;
      const contractBefore = await ethers.provider.getBalance(await axr.getAddress());
      await axr.connect(alice).cancelChallenge(cid);
      const contractAfter = await ethers.provider.getBalance(await axr.getAddress());
      expect(contractBefore - contractAfter).to.equal(DRAW_PRICE);
      const info = await axr.challengeInfo(cid);
      expect(info.done).to.equal(true);
    });

    it("win streak >= 3 doubles points; underdog bonus applies", async function () {
      const { axr, alice, bob, carol, erin } = await deploy();
      const A = await mintRobot(axr, alice);
      await mintRobot(axr, bob);
      await mintRobot(axr, carol);
      await mintRobot(axr, erin);
      await equipPart(axr, alice, 3, 3, 100);
      await equipPart(axr, alice, 2, 3, 500);
      await freeDuel(axr, alice, bob); // win 1: +10
      await freeDuel(axr, alice, carol); // win 2: +10
      expect(await axr.pointsOf(A.robotId, 0)).to.equal(20);
      await nextDay();
      await freeDuel(axr, alice, erin); // win 3: streak x2 -> +20
      expect(await axr.pointsOf(A.robotId, 0)).to.equal(40);
    });

    it("underdog winner earns the power-gap bonus", async function () {
      const { axr, alice, bob } = await deploy();
      const A = await mintRobot(axr, alice);
      const B = await mintRobot(axr, bob);
      // Alice: glass cannon (wins the fight, lower power). Bob: tanky stats that inflate power.
      await equipPart(axr, alice, 3, 3, 100); // Weapon ATK 100
      await equipPart(axr, alice, 1, 3, 100); // Visor ACC +100
      await equipPart(axr, bob, 2, 3, 500); // Core HP 500
      await equipPart(axr, bob, 6, 3, 100); // Legs SPD 100
      await equipPart(axr, bob, 7, 3, 100); // Drone LUCK 100
      const pA = await axr.powerOf(A.robotId);
      const pB = await axr.powerOf(B.robotId);
      expect(pB).to.be.greaterThan(pA);
      const gapBonus = (pB - pA) / 5n;
      const expected = 10n + (gapBonus > 20n ? 20n : gapBonus);
      const res = await freeDuel(axr, alice, bob);
      expect(Number(res.winnerRobot)).to.equal(Number(A.robotId));
      expect(await axr.pointsOf(A.robotId, 0)).to.equal(expected);
    });
  });

  describe("bounty board", function () {
    it("paid-duel winner claims the bounty on the loser in full", async function () {
      const { axr, alice, bob, carol } = await deploy();
      await mintRobot(axr, alice);
      const B = await mintRobot(axr, bob);
      await mintRobot(axr, carol);
      await equipPart(axr, alice, 3, 3, 100);
      await equipPart(axr, alice, 2, 3, 500);
      const bountyAmt = ethers.parseEther("0.01");
      const tx = await axr.connect(carol).postBounty(B.robotId, { value: bountyAmt });
      const rc = await tx.wait();
      const bid = findEvent(axr, rc, "BountyPosted").bountyId;
      // alice creates the paid challenge first, THEN we snapshot her balance
      // (so her entry + gas are already spent and the delta is payout-only).
      const tx1 = await axr.connect(alice).createChallenge(0, true, true, { value: DRAW_PRICE });
      const rc1 = await tx1.wait();
      const cid = findEvent(axr, rc1, "ChallengeCreated").challengeId;
      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx2 = await axr.connect(bob).acceptChallenge(cid, { value: DRAW_PRICE });
      const rc2 = await tx2.wait();
      const res = findEvent(axr, rc2, "DuelResolved");
      expect(res.bountyPaid).to.equal(bountyAmt);
      const balAfter = await ethers.provider.getBalance(alice.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("0.0018") + bountyAmt);
      const info = await axr.bountyInfo(bid);
      expect(info.active).to.equal(false);
    });

    it("poster reclaims after 7 days, not before", async function () {
      const { axr, alice, erin } = await deploy();
      const A = await mintRobot(axr, alice);
      const amt = ethers.parseEther("0.005");
      const tx = await axr.connect(erin).postBounty(A.robotId, { value: amt });
      const rc = await tx.wait();
      const bid = findEvent(axr, rc, "BountyPosted").bountyId;
      await expect(axr.connect(erin).reclaimBounty(bid)).to.be.revertedWith("too early to reclaim");
      await time.increase(7 * DAY + 1);
      const contractBalBefore = await ethers.provider.getBalance(await axr.getAddress());
      await axr.connect(erin).reclaimBounty(bid);
      const contractBalAfter = await ethers.provider.getBalance(await axr.getAddress());
      expect(contractBalBefore - contractBalAfter).to.equal(amt);
      const info = await axr.bountyInfo(bid);
      expect(info.active).to.equal(false);
    });
  });

  describe("seasons", function () {
    it("settles an empty season cleanly", async function () {
      const { axr, dave } = await deploy();
      await time.increase(14 * DAY + 1);
      await axr.connect(dave).settleSeason(0);
      expect(await axr.seasonSettled(0)).to.equal(true);
      expect(await axr.vaultRemaining()).to.equal(50);
      await expect(axr.connect(dave).settleSeason(0)).to.be.revertedWith("season already settled");
    });

    it("pays 50% of the pool to Top 20 by rank weight and runs the Legendary lottery", async function () {
      const { axr, alice, bob, carol, dave, erin } = await deploy();
      const players = [alice, bob, carol, erin];
      const robots = [];
      for (const p of players) robots.push((await mintRobot(axr, p)).robotId);
      // build the pool with paid draws (2/day each)
      for (let d = 0; d < 3; d++) {
        for (const p of players) { await drawPaid(axr, p); await drawPaid(axr, p); }
        await nextDay();
      }
      const poolBefore = await axr.rewardPool();
      expect(poolBefore).to.equal(POOL_PER_DRAW * 24n);
      // duels until at least 3 distinct robots have scored
      const pairs = [[alice, bob], [carol, erin], [alice, carol], [bob, erin], [alice, erin], [bob, carol]];
      let pi = 0;
      while ((await axr.seasonScorerCount(0)) < 3 && pi < pairs.length) {
        await freeDuel(axr, pairs[pi][0], pairs[pi][1]);
        pi++;
        if (pi % 2 === 0) await nextDay();
      }
      const scorerCount = Number(await axr.seasonScorerCount(0));
      expect(scorerCount).to.be.greaterThanOrEqual(3);
      const topCount = Math.min(20, scorerCount);
      // expected total payout = sum of floored rank shares of pool/2
      const poolHalf = poolBefore / 2n;
      let expectedTotal = 0n;
      for (let r = 0; r < topCount; r++) expectedTotal += (poolHalf * BigInt(21 - r)) / 210n;
      const vaultIds = await axr.vaultPreview(3);
      const balsBefore = [];
      for (const p of players) balsBefore.push(await ethers.provider.getBalance(p.address));
      await time.increase(14 * DAY + 1);
      await axr.connect(dave).settleSeason(0);
      expect(await axr.seasonSettled(0)).to.equal(true);
      expect(await axr.totalPoolPaidOut()).to.equal(expectedTotal);
      expect(await axr.rewardPool()).to.equal(poolBefore - expectedTotal);
      let gained = 0n;
      for (let i = 0; i < players.length; i++) {
        gained += (await ethers.provider.getBalance(players[i].address)) - balsBefore[i];
      }
      expect(gained).to.equal(expectedTotal);
      // lottery: exactly the first 3 vault tokens left, to 3 distinct players
      expect(await axr.vaultRemaining()).to.equal(47);
      const newOwners = new Set();
      for (const id of vaultIds) {
        const o = await axr.ownerOf(id);
        newOwners.add(o);
        expect(players.map((p) => p.address)).to.include(o);
        const t = await axr.tokenInfo(id);
        expect(t.champion).to.equal(true);
      }
      expect(newOwners.size).to.equal(3);
    });

    it("cannot settle a running season", async function () {
      const { axr, dave } = await deploy();
      await expect(axr.connect(dave).settleSeason(0)).to.be.revertedWith("season not finished");
    });
  });

  describe("owner = zero game power", function () {
    it("owner() is the deployer; only setBaseURI is privileged", async function () {
      const { axr, creator, alice } = await deploy(false);
      expect(await axr.owner()).to.equal(creator.address);
      await expect(axr.connect(alice).setBaseURI("https://x/")).to.be.revertedWith("not creator");
      await axr.connect(creator).setBaseURI("https://example.com/meta/");
      expect(await axr.baseURI()).to.equal("https://example.com/meta/");
    });

    it("exposes no withdraw / mint / pause / odds functions", async function () {
      const { axr } = await deploy(false);
      for (const f of ["withdraw", "mint", "pause", "setOdds", "setDrawPrice", "rescue", "sweep"]) {
        expect(axr[f], f).to.equal(undefined);
      }
    });

    it("royalties are 5% to the creator", async function () {
      const { axr, creator, alice } = await deploy(false);
      const { accessoryId } = await mintRobot(axr, alice);
      const [receiver, amount] = await axr.royaltyInfo(accessoryId, ethers.parseEther("1"));
      expect(receiver).to.equal(creator.address);
      expect(amount).to.equal(ethers.parseEther("0.05"));
    });

    it("tokenURI works on-chain and follows baseURI when set", async function () {
      const { axr, creator, alice } = await deploy(false);
      const { robotId } = await mintRobot(axr, alice);
      const uri = await axr.tokenURI(robotId);
      expect(uri).to.include("data:application/json;base64,");
      await axr.connect(creator).setBaseURI("https://example.com/meta/");
      expect(await axr.tokenURI(robotId)).to.equal("https://example.com/meta/" + robotId.toString());
    });
  });

  describe("draw odds sanity (statistical, wide bounds)", function () {
    it("100 paid draws: rarities and stat bands stay in bounds", async function () {
      const { axr, alice, bob, carol, erin, frank } = await deploy();
      const users = [alice, bob, carol, erin, frank];
      for (const u of users) await mintRobot(axr, u);
      const counts = [0, 0, 0, 0];
      for (let d = 0; d < 10; d++) {
        for (const u of users) {
          for (let k = 0; k < 2; k++) {
            const id = await drawPaid(axr, u);
            const t = await axr.tokenInfo(id);
            counts[Number(t.rarity)]++;
            const [lo, hi] = BANDS[Number(t.rarity)];
            const mult = Number(t.accType) === 2 ? 5 : 1;
            expect(t.stat).to.be.within(lo * mult, hi * mult);
          }
        }
        await nextDay();
      }
      expect(counts[0] + counts[1] + counts[2] + counts[3]).to.equal(100);
      expect(counts[0]).to.be.greaterThanOrEqual(50); // ~70 expected
      expect(counts[3]).to.be.lessThanOrEqual(5); // 0.1% -> ~0 expected
    });
  });
});
