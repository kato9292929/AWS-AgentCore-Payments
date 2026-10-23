"""Permit2 への USDC 承認をオンチェーンで確かめる（AC-3b 用。TS 版は scripts/ac3/allowance.ts）。

ProcessPayment は承認 tx のハッシュを返さないので、USDC の Approval イベント（owner=ウォレット、spender=Permit2）を
ログから引いて tx ハッシュと gas 代を取る。承認額は USDC.allowance(wallet, Permit2) を eth_call で直接読む。
公開 RPC は eth_getLogs を 200 ブロックの範囲に制限するので刻んで引く。

完全に 0 に戻すには、ウォレット側で USDC.approve(Permit2, 0) を送る必要がある。AgentCore の API からはできない。
"""

from __future__ import annotations

import time
from decimal import Decimal
from typing import Any, Dict, List, Optional

import httpx

PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"
LOG_RANGE = 200


def _pad(addr: str) -> str:
    return "0x" + addr.lower().removeprefix("0x").rjust(64, "0")


class Chain:
    def __init__(self, rpc: str):
        self.rpc = rpc

    def call(self, method: str, params: List[Any]) -> Any:
        r = httpx.post(self.rpc, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=20).json()
        if "error" in r:
            raise RuntimeError(f"{method}: {r['error']}")
        return r["result"]

    def block_number(self) -> int:
        return int(self.call("eth_blockNumber", []), 16)

    def allowance(self, usdc: str, owner: str) -> str:
        data = "0xdd62ed3e" + _pad(owner)[2:] + _pad(PERMIT2)[2:]  # allowance(address,address)
        return str(int(self.call("eth_call", [{"to": usdc, "data": data}, "latest"]), 16))

    def approvals(self, usdc: str, owner: str, from_block: int) -> List[Dict[str, Any]]:
        latest = self.block_number()
        out: List[Dict[str, Any]] = []
        b = from_block
        while b <= latest:
            to = min(b + LOG_RANGE - 1, latest)
            logs = self.call("eth_getLogs", [{
                "address": usdc, "fromBlock": hex(b), "toBlock": hex(to),
                "topics": [APPROVAL_TOPIC, _pad(owner), _pad(PERMIT2)],
            }])
            for lg in logs:
                rc = self.call("eth_getTransactionReceipt", [lg["transactionHash"]])
                gas = int(rc["gasUsed"], 16) * int(rc.get("effectiveGasPrice", "0x0"), 16)
                out.append({
                    "txHash": lg["transactionHash"],
                    "blockNumber": str(int(lg["blockNumber"], 16)),
                    "value": str(int(lg["data"], 16)),
                    "gasUsed": str(int(rc["gasUsed"], 16)),
                    "gasCostEth": str(Decimal(gas) / Decimal(10**18)),
                })
            b = to + 1
        return out

    def wait_for_approval(self, usdc: str, owner: str, from_block: int, value: str, timeout_s: int = 90) -> Optional[Dict[str, Any]]:
        started = time.time()
        while time.time() - started < timeout_s:
            hit = next((a for a in self.approvals(usdc, owner, from_block) if a["value"] == value), None)
            if hit:
                return hit
            time.sleep(3)
        return None
