"""支払い先 allowlist（AC-2）の Python 版。src/guard/payToAllowlist.ts と同じ設定ファイルを読む。

Strands プラグイン / PaymentManager には「誰に払うか」を縛る設定が無い。
network_preferences_config も並べ替えのヒントでしかなく、一致しなければ先頭の accept
（mainnet でありうる）に落ちる（docs/T4-T5-blocked.md）。

そこで generate_payment_header に渡す前に、402 の中身を allowlist で**削る**:
  x402: accepts[] のうち (payTo, network) が allowlist に一致するものだけを残す
  MPP : WWW-Authenticate の Payment チャレンジのうち (recipient, chainId) が一致するものだけを残す
残らなければ署名に進まない（PaymentError を投げる → プラグインは失敗として記録し、再送しない）。

これはハーネス側の拘束であって SDK の機能ではない。testnet に留める主たる手段は
「叩く先を testnet の売り手に限る」「ウォレットに testnet USDC しか入れない」の 2 つのまま。
"""

from __future__ import annotations

import base64
import copy
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "config" / "payto-allowlist.json"

_SLUG_TO_CAIP2 = {
    "base-sepolia": "eip155:84532",
    "ethereum-sepolia": "eip155:11155111",
    "avalanche-fuji": "eip155:43113",
    "base": "eip155:8453",
}


class PayToRejected(Exception):
    """allowlist に一致する支払い先が 402 に 1 件も無い。"""


def _norm(network: str) -> str:
    n = str(network).strip().lower()
    return _SLUG_TO_CAIP2.get(n, n)


class PayToAllowlist:
    def __init__(self, entries: List[Dict[str, Any]]):
        self.pairs = {
            (e["payTo"].lower(), _norm(n)): e.get("label", "") for e in entries for n in e.get("networks", [])
        }

    @classmethod
    def load(cls, path: str | Path = DEFAULT_PATH) -> "PayToAllowlist":
        return cls(json.loads(Path(path).read_text(encoding="utf-8")).get("entries", []))

    def allows(self, pay_to: str, network: str) -> bool:
        return (str(pay_to).lower(), _norm(network)) in self.pairs

    # ------------------------------------------------------------------
    def filter_402(self, req: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """payment_required_request（statusCode/headers/body）を allowlist で削った複製と、何を削ったかを返す。"""
        out = copy.deepcopy(req)
        report: Dict[str, Any] = {"kept": [], "dropped": []}
        headers = out.get("headers") or {}

        # x402 v2: PAYMENT-REQUIRED ヘッダ
        for key in list(headers.keys()):
            if key.lower() == "payment-required":
                payload = json.loads(base64.b64decode(headers[key]))
                payload["accepts"] = self._filter_accepts(payload.get("accepts", []), report)
                headers[key] = base64.b64encode(json.dumps(payload).encode()).decode()

        # x402 v1: body
        body = out.get("body")
        if isinstance(body, dict) and isinstance(body.get("accepts"), list):
            body["accepts"] = self._filter_accepts(body["accepts"], report)

        # MPP: WWW-Authenticate: Payment ...
        for key in list(headers.keys()):
            if key.lower() == "www-authenticate" and re.search(r"Payment\s", str(headers[key]), re.I):
                kept = [c for c in _split_challenges(headers[key]) if self._mpp_ok(c, report)]
                if kept:
                    headers[key] = ", ".join(kept)
                else:
                    del headers[key]

        if not report["kept"]:
            raise PayToRejected(f"allowlist に一致する支払い先が無い: {report['dropped']}")
        return out, report

    def _filter_accepts(self, accepts: List[Dict[str, Any]], report: Dict[str, Any]) -> List[Dict[str, Any]]:
        kept = []
        for a in accepts:
            item = {"protocol": "x402", "payTo": a.get("payTo"), "network": a.get("network"), "scheme": a.get("scheme")}
            if self.allows(a.get("payTo", ""), a.get("network", "")):
                kept.append(a)
                report["kept"].append(item)
            else:
                report["dropped"].append(item)
        return kept

    def _mpp_ok(self, challenge: str, report: Dict[str, Any]) -> bool:
        m = re.search(r'request="([^"]+)"', challenge)
        try:
            raw = m.group(1) if m else ""
            req = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        except Exception:  # noqa: BLE001
            report["dropped"].append({"protocol": "MPP", "reason": "request を読めない"})
            return False
        chain = (req.get("methodDetails") or {}).get("chainId")
        item = {"protocol": "MPP", "payTo": req.get("recipient"), "network": f"eip155:{chain}"}
        ok = chain is not None and self.allows(req.get("recipient", ""), f"eip155:{chain}")
        report["kept" if ok else "dropped"].append(item)
        return ok


def _split_challenges(value: str) -> List[str]:
    return [c.strip() for c in re.split(r",\s*(?=Payment\s)", value, flags=re.I) if re.match(r"Payment\b", c.strip(), re.I)]
