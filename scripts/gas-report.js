const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
async function main() {
  const [creator, alice, bob] = await ethers.getSigners();
  const Mock = await ethers.getContractFactory("MockAgentID");
  const mock = await Mock.deploy();
  const F = await ethers.getContractFactory("AgentXRobot");
  const tx = await F.getDeployTransaction(await mock.getAddress());
  const est = await ethers.provider.estimateGas(tx);
  const axr = await F.deploy(await mock.getAddress());
  const drc = await axr.deploymentTransaction().wait();
  console.log("deploy gas (actual):", drc.gasUsed.toString(), "estimate:", est.toString());
  await mock.setHolder(alice.address, true); await mock.setHolder(bob.address, true);
  let r = await (await axr.connect(alice).mintRobot()).wait(); console.log("mintRobot gas:", r.gasUsed.toString());
  await (await axr.connect(bob).mintRobot()).wait();
  r = await (await axr.connect(alice).drawAccessory({ value: ethers.parseEther("0.001") })).wait(); console.log("drawAccessory gas:", r.gasUsed.toString());
  const c = await (await axr.connect(alice).createChallenge(0, true, false)).wait();
  const cid = 0;
  r = await (await axr.connect(bob).acceptChallenge(cid)).wait(); console.log("free duel accept (fight) gas:", r.gasUsed.toString());
  r = await (await axr.connect(alice).drawAccessory({ value: ethers.parseEther("0.001") })).wait(); console.log("draw2 gas:", r.gasUsed.toString());
}
main().catch(e => { console.error(e); process.exit(1); });
