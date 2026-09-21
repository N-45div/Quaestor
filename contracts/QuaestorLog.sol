// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title QuaestorLog — what the hub would otherwise forget
/// @notice An append-only log with no storage, no owner and no way to delete.
///
/// The governor commits the keccak256 of each decision record in its Receipt,
/// and stops there: the reasoning behind a spend is too large and too varied to
/// keep in contract storage. So the text lived in the hub's memory, and every
/// redeploy made the receipts it explained unopenable.
///
/// This puts the text in event data instead, which costs a fraction of a cent on
/// an L2 and is kept by every archive node and indexer that follows the chain.
/// Nothing here is trusted: a record's hash is computed here from the bytes
/// published, so a reader recomputes it and compares it with the Receipt. Anyone
/// may publish, and it does not matter who does.
///
/// Threat reports go here for the same reason, but the trust is different and
/// is stated plainly: the chain makes a report append-only and permanent, while
/// whether the reporter is a verified human is decided by whoever relayed it.
/// A reader counts only reports relayed by an address it trusts to have checked.
contract QuaestorLog {
    uint256 public constant MAX_RECORD_BYTES = 8192;
    uint256 public constant MAX_FIELD_BYTES = 256;

    /// @param metaHash keccak256 of `record`, computed here, never supplied.
    event Published(bytes32 indexed metaHash, address indexed publisher, bytes record);

    /// @param venueHash keccak256 of `venue`, for filtering by venue.
    /// @param humanId the verified human behind the report, or zero if unverified.
    /// @param tenantHash keccak256 of the tenant's id: countable, not named.
    event Reported(
        bytes32 indexed venueHash,
        bytes32 indexed humanId,
        address indexed reporter,
        string venue,
        string pattern,
        bytes32 tenantHash
    );

    error EmptyRecord();
    error RecordTooLarge(uint256 size, uint256 max);
    error FieldTooLarge(uint256 size, uint256 max);

    /// @notice Publish a decision record. Returns the hash a Receipt would carry.
    function publish(bytes calldata record) external returns (bytes32 metaHash) {
        if (record.length == 0) revert EmptyRecord();
        if (record.length > MAX_RECORD_BYTES) revert RecordTooLarge(record.length, MAX_RECORD_BYTES);
        metaHash = keccak256(record);
        emit Published(metaHash, msg.sender, record);
    }

    /// @notice Report a venue an agent was attacked through.
    /// @dev `venue` is expected already normalised (lower-cased, trimmed): the
    /// hash is taken of exactly these bytes, so two spellings are two venues.
    function report(
        string calldata venue,
        string calldata pattern,
        bytes32 humanId,
        bytes32 tenantHash
    ) external {
        if (bytes(venue).length == 0) revert EmptyRecord();
        if (bytes(venue).length > MAX_FIELD_BYTES) revert FieldTooLarge(bytes(venue).length, MAX_FIELD_BYTES);
        if (bytes(pattern).length > MAX_FIELD_BYTES) revert FieldTooLarge(bytes(pattern).length, MAX_FIELD_BYTES);
        emit Reported(keccak256(bytes(venue)), humanId, msg.sender, venue, pattern, tenantHash);
    }
}
