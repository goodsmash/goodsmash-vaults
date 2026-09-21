"""Patch DevBarter.isExecutable so the pre-flight check can always be trusted to ANSWER.

WHY
  isExecutable is the function that makes this contract agent-composable: you hand it
  trade TERMS (no signatures, no wallet, no gas) and it tells you whether they would
  execute. But the original called IERC721(...).ownerOf(...) directly, and ownerOf on an
  address with no code REVERTS WITH NO DATA. So an agent asking one simple question got:

      (false, "expired")     for some conditions
      a bare revert          for others

  Two error paths for one question is not composable policy. This version never reverts.

WHAT IT ADDS
  1. code.length checks before every ownerOf - a bad collection becomes a reason string
  2. the MAX_OFFER_WINDOW expiry check, now reported here instead of only enforced elsewhere
  3. side-length checks: makerCollections.length must equal makerTokenIds.length (and the
     same for taker). The struct keeps them as separate arrays, so a malformed trade could
     otherwise slip past validation.
  4. a machine-readable reason on every failure path
"""
import io

P = "contracts/DevBarter.sol"
s = io.open(P, encoding="utf-8").read()

marker = "    function isExecutable(Trade calldata t) external view returns (bool executable, string memory reason) {"
start = s.find(marker)
if start == -1:
    print("  isExecutable not found - nothing changed")
    raise SystemExit(1)

end_marker = '        return (true, "ok");\n    }\n'
end = s.find(end_marker, start)
if end == -1:
    print("  end marker not found - nothing changed")
    raise SystemExit(1)
end += len(end_marker)

old_fn = s[start:end]

new_fn = (
'    /// @notice Would these trade terms execute right now?\n'
'    /// @dev    NEVER REVERTS. Every failure path returns (false, reason) with a\n'
'    ///         machine-readable reason, including a collection that is not a contract and\n'
'    ///         a malformed trade whose sides disagree in length. That property is the\n'
'    ///         point: an agent can call this as a pre-flight check and branch on the\n'
'    ///         result without also writing a revert handler. Takes TERMS ONLY - no\n'
'    ///         signatures - so it can be asked before anything is signed, costs no gas,\n'
'    ///         and needs no wallet.\n'
'    function isExecutable(Trade calldata t) external view returns (bool executable, string memory reason) {\n'
'        // --- time -------------------------------------------------------------\n'
'        if (t.expiry <= block.timestamp) return (false, "expired");\n'
'        if (t.expiry > block.timestamp + MAX_OFFER_WINDOW) return (false, "expiry beyond max window");\n'
'\n'
'        // --- replay and identity ----------------------------------------------\n'
'        if (nonceUsed[t.maker][t.nonce]) return (false, "cancelled or already used");\n'
'        if (t.maker == t.taker) return (false, "same account");\n'
'        if (t.maker == address(0) || t.taker == address(0)) return (false, "zero account");\n'
'\n'
'        // --- shape ------------------------------------------------------------\n'
'        uint256 m = t.makerCollections.length;\n'
'        uint256 k = t.takerCollections.length;\n'
'        if (m == 0 || k == 0 || m > MAX_TOKENS_PER_SIDE || k > MAX_TOKENS_PER_SIDE) {\n'
'            return (false, "bad side length");\n'
'        }\n'
'        // collections and ids are separate arrays, so a malformed trade can disagree\n'
'        // about how many tokens a side is offering\n'
'        if (m != t.makerTokenIds.length) return (false, "maker side length mismatch");\n'
'        if (k != t.takerTokenIds.length) return (false, "taker side length mismatch");\n'
'\n'
'        // --- ownership, without ever reverting --------------------------------\n'
'        // ownerOf() on a code-less address reverts with no data, which would turn this\n'
'        // pre-flight into an unanswerable question. Check for code first.\n'
'        for (uint256 i = 0; i < m; i++) {\n'
'            address c = t.makerCollections[i];\n'
'            if (c.code.length == 0) return (false, "maker collection is not a contract");\n'
'            if (IERC721(c).ownerOf(t.makerTokenIds[i]) != t.maker) {\n'
'                return (false, "maker no longer owns a token");\n'
'            }\n'
'        }\n'
'        for (uint256 i = 0; i < k; i++) {\n'
'            address c = t.takerCollections[i];\n'
'            if (c.code.length == 0) return (false, "taker collection is not a contract");\n'
'            if (IERC721(c).ownerOf(t.takerTokenIds[i]) != t.taker) {\n'
'                return (false, "taker no longer owns a token");\n'
'            }\n'
'        }\n'
'\n'
'        return (true, "ok");\n'
'    }\n'
)

s = s[:start] + new_fn + s[end:]
io.open(P, "w", encoding="utf-8").write(s)
print(f"  rewritten: {len(old_fn)} -> {len(new_fn)} chars")
print("  code-length guards :", "c.code.length == 0" in new_fn)
print("  window check       :", "expiry beyond max window" in new_fn)
print("  side-length checks :", new_fn.count("side length mismatch") == 2)
