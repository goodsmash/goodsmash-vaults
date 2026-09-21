// SPDX-License-Identifier: MIT
/*
 * GoodsMash Rigs - thanks for using this.
 * Built in the open at github.com/goodsmash/goodsmash-vaults
 * Copy it, fork it, deploy your own - that is what it is here for.
 */
pragma solidity ^0.8.28;

/**
 * @title DeterministicDeployer
 * @notice Deploy ANY contract at the SAME ADDRESS on every EVM chain.
 *
 * WHY OMNICHAIN MATTERS HERE, AND WHY IT IS NOT A BRIDGE
 *
 *   Deploy the same contract on ten chains and you normally get ten different addresses. A
 *   user who verified your address on one chain cannot recognise it on another, so they must
 *   re-verify by hand every time - and repeated "just check this again" is exactly the habit
 *   that phishing erodes. Ten addresses is ten chances to be fooled. ONE address is something
 *   a person can actually remember and recognise.
 *
 *   CREATE2 derives an address from (deployer, salt, keccak(initCode)). None of those inputs is
 *   the chain id. So the same deployer, the same salt and the same bytecode produce an
 *   IDENTICAL ADDRESS ON EVERY CHAIN.
 *
 *   That delivers the property people want from "omnichain" - one address, good everywhere -
 *   with NO message-passing layer, and therefore none of the attack surface that gets bridges
 *   drained. There is no bridge here to exploit because there is no bridge.
 *
 * WHY THIS VERSION TAKES THE BYTECODE AS AN ARGUMENT
 *
 *   An earlier draft embedded `type(X).creationCode` for each contract it deployed. That made
 *   the deployer 23,787 bytes against the 24,576-byte EIP-170 limit - 97% full, with under
 *   800 bytes of headroom, so adding a fifth contract would have bricked it. Accepting the
 *   creation code as calldata keeps this contract tiny and makes it work for ANY contract,
 *   including ones that did not exist when this was written.
 *
 * WHAT THIS DOES NOT DO
 *
 *   It does not share STATE across chains. A lock made on one chain is not visible on another;
 *   that needs a bridge, and cross-chain custody is deliberately refused. Cross-chain READING
 *   is safe and is done offchain by aggregating each chain's RPC. Reads can be merged without a
 *   bridge; writes cannot.
 *
 * SAFETY PROPERTIES
 *
 *   - NO OWNER. NO FEE. NO PAUSE. Nothing to compromise.
 *   - FAIL-CLOSED: reverts if the target address is already occupied, so running it twice can
 *     never silently create a second, different contract.
 *   - It holds no funds and can never move anything it did not itself create.
 *   - `predict()` is a free read, so anyone can check what WOULD be created before signing.
 */
contract DeterministicDeployer {
    event Deployed(bytes32 indexed salt, address at);

    error AlreadyDeployed(address at);
    error DeployFailed(bytes32 salt);
    error EmptyCode();

    /**
     * @notice Deploy `initCode` at the address determined by `salt`.
     * @param salt      arbitrary; the same salt + same code + same deployer = same address
     * @param initCode  the full creation bytecode (constructor args appended)
     */
    function deploy(bytes32 salt, bytes calldata initCode) external returns (address a) {
        if (initCode.length == 0) revert EmptyCode();
        bytes32 h = keccak256(initCode);
        a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, h)))));

        // Fail closed. An occupied address means this exact deployment already happened here.
        if (a.code.length != 0) revert AlreadyDeployed(a);

        bytes memory code = initCode;
        assembly {
            a := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (a == address(0)) revert DeployFailed(salt);

        emit Deployed(salt, a);
    }

    /**
     * @notice What address WOULD `deploy(salt, initCode)` produce? Pure read, costs nothing.
     * @dev A frontend can show a user the address before they sign, so "trust me" is never
     *      required - the address is checkable in advance and identical on every chain.
     */
    function predict(bytes32 salt, bytes calldata initCode) external view returns (address) {
        if (initCode.length == 0) revert EmptyCode();
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode))))));
    }

    /**
     * @notice Convenience: has this deployer already put something at `salt`+`initCode`?
     */
    function alreadyAt(bytes32 salt, bytes calldata initCode) external view returns (bool) {
        if (initCode.length == 0) return false;
        address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode))))));
        return a.code.length != 0;
    }
}
