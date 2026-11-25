// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./AgentXRobot.sol";

/// @title AXRTestHarness — LOCAL TESTS ONLY
/// @notice Subclass exposing deterministic staging helpers for the test
/// suite (minting a specific part, or pre-filling the draw counters to
/// the supply cap — states that would take ~20,000 random draws to reach
/// organically). NEVER deploy this contract; AgentXRobot itself has no
/// external path to these helpers.
contract AXRTestHarness is AgentXRobot {
    constructor(address registry) AgentXRobot(registry) {}

    function debugMintAccessory(address to, uint8 accType, uint8 rarity, uint32 stat)
        external
        returns (uint256 tokenId)
    {
        tokenId = _mintRaw(
            to,
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
    }

    function debugSetDrawnPerType(uint8 accType, uint256 n) external {
        _testSetDrawnPerType(accType, n);
    }
}
