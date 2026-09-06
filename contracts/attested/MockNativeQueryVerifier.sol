// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @notice Test double for the Attestcoin BlockProver precompile. Tests install its
///         runtime bytecode at the precompile address (0x…0FD2) with `hardhat_setCode`,
///         so ASCBase's constant-address call lands here on a local chain.
///         Storage starts empty at that address, so the default is "verified".
contract MockNativeQueryVerifier is INativeQueryVerifier {
    bool public reject;

    function setReject(bool r) external {
        reject = r;
    }

    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata
    ) external returns (bool) {
        if (reject) return false;
        emit TransactionVerified(chainKey, height, _index(merkleProof));
        return true;
    }

    function verifyAndEmit(
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata,
        MerkleProof[] calldata merkleProofs,
        ContinuityProof calldata
    ) external returns (bool) {
        if (reject) return false;
        for (uint256 i; i < heights.length; ++i) {
            emit TransactionVerified(chainKey, heights[i], _index(merkleProofs[i]));
        }
        return true;
    }

    function verify(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external
        view
        returns (bool)
    {
        return !reject;
    }

    function verify(uint64, uint64[] calldata, bytes[] calldata, MerkleProof[] calldata, ContinuityProof calldata)
        external
        view
        returns (bool)
    {
        return !reject;
    }

    /// @dev The transaction index is the path through the tree: a right-sibling at level i
    ///      means the leaf is on the left at that level, i.e. bit i is 0.
    function calculateTxIndex(MerkleProof calldata merkleProof) external pure returns (uint64) {
        return _index(merkleProof);
    }

    function _index(MerkleProof calldata p) internal pure returns (uint64 idx) {
        for (uint256 i; i < p.siblings.length; ++i) {
            if (p.siblings[i].isLeft) idx |= uint64(1) << uint64(i);
        }
    }
}
