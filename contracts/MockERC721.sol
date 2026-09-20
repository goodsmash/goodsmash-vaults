// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev Minimal test mock — local hardhat networks only, never deployed.
contract MockERC721 is ERC721 {
    uint256 public nextId = 1;
    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) {}

    function mintTo(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}
