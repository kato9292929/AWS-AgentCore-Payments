"""AgentCore データプレーンの差し替え（AC-1 D3 / AC-2 / AC-3 の Python 側で共用）。

2 種類ある。

  LocalPlane … AgentCore を呼ばずに、ProcessPayment を手元で再現する。
               EIP-3009（x402 exact）を eth_account で実際に署名するので、模擬売り手の
               署名検証は通る。採取ログには plane="local-fake" が入る。
               予算・冪等性・エラーは、2026-11-23 の実測（ap-southeast-2、artifacts/ac1/D0〜D8.json）に合わせてある:
                 - 応答はトップレベルに createdAt / paymentInstrumentId / paymentManagerArn / paymentOutput /
                   paymentSessionId / paymentType / processPaymentId / status / updatedAt
                 - 予算は証明を作った時点で減る（売り手への再送や settle を待たない）
                 - 同じ clientToken なら同じ processPaymentId を返し、予算は 1 回分しか減らない
                 - 予算が足りなければ ValidationException（HTTP 400）
                   "Insufficient budget for session <id>. Pending amount: 0 USD, Transaction amount: <x> USD"
                 - 有効期限が切れたセッションは「存在しない」扱い（D5）: ProcessPayment は ValidationException（HTTP 400）
                   "Payment session not found: <id>"、GetPaymentSession は ResourceNotFoundException
               これは実測の写しであって実測そのものではない。結果表には使わない（使うのは AgentCore の応答だけ）。

  spy(manager) … 本物の PaymentManager の boto3 クライアントに覗き窓を付ける。
               ProcessPayment に渡った clientToken・入力・出力・例外をそのまま記録する。

鍵の扱い: LocalPlane の鍵はプロセス内で生成し、ファイルにもログにも出さない（アドレスのみ）。
"""

from __future__ import annotations

import json
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

TESTNET_EVM = {"base-sepolia": 84532, "eip155:84532": 84532}


@dataclass
class CallLog:
    """ProcessPayment 1 回分の記録。署名値は残さず長さだけ。"""

    plane: str
    client_token: str
    payment_type: str
    payment_session_id: str
    payload_summary: Dict[str, Any]
    at: float
    process_payment_id: Optional[str] = None
    status: Optional[str] = None
    error: Optional[str] = None
    extra: Dict[str, Any] = field(default_factory=dict)


class LocalPlane:
    """boto3 の bedrock-agentcore クライアントのうち、SDK が呼ぶメソッドだけを持つ偽物。"""

    def __init__(self) -> None:
        from eth_account import Account  # 遅延 import（live のときは要らない）

        self._account = Account.create()  # 鍵はこのオブジェクトの中だけ
        self.address = self._account.address
        self.calls: List[CallLog] = []
        # sessionId -> 残予算（Decimal）。作っていないセッション ID は上限なしとして扱う（D3 など）
        self._budget: Dict[str, Any] = {}
        # clientToken -> 最初の応答（実測: 同じ token なら同じ応答、予算は 1 回分）
        self._by_token: Dict[str, Dict[str, Any]] = {}
        # sessionId -> 期限（epoch 秒）
        self._expires: Dict[str, float] = {}
        # boto3 クライアントと同じ属性を最低限そろえる（SDK が events.register を呼ぶ）
        self.meta = _Meta()

    # --- SDK が呼ぶメソッド ---
    def get_payment_instrument(self, **_: Any) -> Dict[str, Any]:
        return {
            "paymentInstrument": {
                "paymentInstrumentId": "local-instrument",
                "status": "ACTIVE",
                "paymentInstrumentDetails": {
                    "embeddedCryptoWallet": {"network": "ETHEREUM", "walletAddress": self.address}
                },
            }
        }

    def create_payment_session(self, **params: Any) -> Dict[str, Any]:
        from decimal import Decimal

        sid = f"payment-session-local-{uuid.uuid4().hex[:15]}"
        limit = ((params.get("limits") or {}).get("maxSpendAmount") or {}).get("value")
        self._budget[sid] = Decimal(limit) if limit is not None else None
        self._expires[sid] = time.time() + 60 * int(params.get("expiryTimeInMinutes") or 15)
        return {"paymentSession": {"paymentSessionId": sid, "limits": params.get("limits"),
                                   "expiryTimeInMinutes": params.get("expiryTimeInMinutes"),
                                   "availableLimits": self._available(sid)}}

    def _available(self, sid: str) -> Any:
        b = self._budget.get(sid)
        if b is None:
            return None
        return {"availableSpendAmount": {"value": format(b.normalize(), "f"), "currency": "USD"}}

    def process_payment(self, **params: Any) -> Dict[str, Any]:
        from decimal import Decimal

        from botocore.exceptions import ClientError

        token = params.get("clientToken", "")
        if token and token in self._by_token:
            # 実測 D1: 同じ clientToken → 同じ processPaymentId、予算は減らない
            self.calls.append(CallLog(plane="local-fake", client_token=token, payment_type=params["paymentType"],
                                      payment_session_id=params.get("paymentSessionId", ""),
                                      payload_summary=_summarize(params["paymentInput"]), at=time.time(),
                                      process_payment_id=self._by_token[token]["processPaymentId"],
                                      status="PROOF_GENERATED", extra={"idempotent_replay": True}))
            return self._by_token[token]
        sid0 = params.get("paymentSessionId", "")
        if sid0 in self._expires and time.time() > self._expires[sid0]:
            raise ClientError({"Error": {"Code": "ValidationException", "Message": f"Payment session not found: {sid0}"},
                               "ResponseMetadata": {"HTTPStatusCode": 400}}, "ProcessPayment")
        ptype = params["paymentType"]
        pin = params["paymentInput"]
        log = CallLog(
            plane="local-fake",
            client_token=params.get("clientToken", ""),
            payment_type=ptype,
            payment_session_id=params.get("paymentSessionId", ""),
            payload_summary=_summarize(pin),
            at=time.time(),
        )
        self.calls.append(log)
        if ptype != "CRYPTO_X402":
            log.error = "LocalPlane は MPP を署名しない（AgentCore 本体の挙動を作らない）"
            raise RuntimeError(log.error)
        accept = pin["cryptoX402"]["payload"]
        version = pin["cryptoX402"]["version"]
        sid = params.get("paymentSessionId", "")
        amount = Decimal(int(accept.get("amount") or accept.get("maxAmountRequired"))) / Decimal(10**6)
        if self._budget.get(sid) is not None and amount > self._budget[sid]:
            log.error = "ValidationException: Insufficient budget"
            raise ClientError(
                {"Error": {"Code": "ValidationException",
                           "Message": f"Insufficient budget for session {sid}. Pending amount: 0 USD, "
                                      f"Transaction amount: {amount:.6f} USD"},
                 "ResponseMetadata": {"HTTPStatusCode": 400}},
                "ProcessPayment",
            )
        payload = self._sign_exact(accept)
        if self._budget.get(sid) is not None:
            self._budget[sid] -= amount  # 実測 D4/D8: 証明を作った時点で減る
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        log.process_payment_id = f"local-{uuid.uuid4()}"
        log.status = "PROOF_GENERATED"
        res = {
            "createdAt": now,
            "paymentInstrumentId": params.get("paymentInstrumentId"),
            "paymentManagerArn": params.get("paymentManagerArn"),
            "paymentOutput": {"cryptoX402": {"version": version, "payload": payload}},
            "paymentSessionId": sid,
            "paymentType": "CRYPTO_X402",
            "processPaymentId": log.process_payment_id,
            "status": "PROOF_GENERATED",
            "updatedAt": now,
        }
        if token:
            self._by_token[token] = res
        return res

    def get_payment_session(self, **params: Any) -> Dict[str, Any]:
        from botocore.exceptions import ClientError

        sid = params.get("paymentSessionId", "")
        if sid in self._expires and time.time() > self._expires[sid]:
            raise ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": f"Payment session not found: {sid}"},
                               "ResponseMetadata": {"HTTPStatusCode": 404}}, "GetPaymentSession")
        return {"paymentSession": {"paymentSessionId": sid, "availableLimits": self._available(sid)}}

    # --- 署名 ---
    def _sign_exact(self, accept: Dict[str, Any]) -> Dict[str, Any]:
        if accept.get("scheme") != "exact":
            raise RuntimeError(f"LocalPlane は exact のみ署名する（scheme={accept.get('scheme')}）")
        network = str(accept.get("network", "")).lower()
        chain_id = TESTNET_EVM.get(network)
        if chain_id is None:
            raise RuntimeError(f"LocalPlane は testnet 以外に署名しない（network={network}）")
        extra = accept.get("extra") or {}
        now = int(time.time())
        value = int(accept.get("amount") or accept.get("maxAmountRequired"))
        auth = {
            "from": self.address,
            "to": accept["payTo"],
            "value": value,
            "validAfter": now - 60,
            "validBefore": now + int(accept.get("maxTimeoutSeconds") or 60),
            "nonce": "0x" + secrets.token_hex(32),
        }
        signed = self._account.sign_typed_data(
            domain_data={
                "name": extra.get("name", "USDC"),
                "version": extra.get("version", "2"),
                "chainId": chain_id,
                "verifyingContract": accept["asset"],
            },
            message_types={
                "TransferWithAuthorization": [
                    {"name": "from", "type": "address"},
                    {"name": "to", "type": "address"},
                    {"name": "value", "type": "uint256"},
                    {"name": "validAfter", "type": "uint256"},
                    {"name": "validBefore", "type": "uint256"},
                    {"name": "nonce", "type": "bytes32"},
                ]
            },
            message_data=auth,
        )
        return {
            "signature": "0x" + signed.signature.hex().removeprefix("0x"),
            "authorization": {**auth, "value": str(value), "validAfter": str(auth["validAfter"]),
                              "validBefore": str(auth["validBefore"])},
        }


class _Meta:
    class _Events:
        def register(self, *_: Any, **__: Any) -> None:
            return None

    events = _Events()


def _summarize(payment_input: Dict[str, Any]) -> Dict[str, Any]:
    if "cryptoX402" in payment_input:
        c = payment_input["cryptoX402"]
        p = c.get("payload") or {}
        return {
            "rail": "x402",
            "version": c.get("version"),
            "scheme": p.get("scheme"),
            "network": p.get("network"),
            "amount": p.get("amount") or p.get("maxAmountRequired"),
            "payTo": p.get("payTo"),
            **({"permit2AllowanceLimit": c["permit2AllowanceLimit"]} if "permit2AllowanceLimit" in c else {}),
        }
    if "mpp" in payment_input:
        m = payment_input["mpp"]
        return {"rail": "mpp", "version": m.get("version"), "buyerPaysGasFees": m.get("buyerPaysGasFees")}
    return {"rail": "unknown"}


def spy(manager: Any, plane_name: str = "agentcore") -> List[CallLog]:
    """本物の PaymentManager の process_payment 呼び出しを記録する。戻り値のリストに追記される。"""
    client = manager._payment_client
    # 2 回呼ばれても二重に包まない（包むと外側の記録に内側の呼び出しが混ざる）。同じリストを返す。
    existing = getattr(client, "_spy_calls", None)
    if existing is not None:
        return existing
    original: Callable[..., Dict[str, Any]] = client.process_payment
    calls: List[CallLog] = []
    client._spy_calls = calls

    def wrapped(**params: Any) -> Dict[str, Any]:
        log = CallLog(
            plane=plane_name,
            client_token=params.get("clientToken", ""),
            payment_type=params.get("paymentType", ""),
            payment_session_id=params.get("paymentSessionId", ""),
            payload_summary=_summarize(params.get("paymentInput", {})),
            at=time.time(),
        )
        calls.append(log)
        try:
            res = original(**params)
        except Exception as e:  # noqa: BLE001 — 例外の型と文言をそのまま残す
            log.error = f"{type(e).__name__}: {e}"
            raise
        body = res.get("processPayment", res)
        log.process_payment_id = body.get("processPaymentId")
        log.status = body.get("status")
        return res

    client.process_payment = wrapped
    return calls


def install_local_plane(manager: Any) -> LocalPlane:
    """PaymentManager の boto3 クライアントを LocalPlane に差し替える。"""
    plane = LocalPlane()
    manager._payment_client = plane
    return plane


def calls_to_json(calls: List[CallLog]) -> List[Dict[str, Any]]:
    return [json.loads(json.dumps(c.__dict__, default=str)) for c in calls]


# --- 出口側の網（src/guard/redact.ts と同じ規則）。Python が書くログもこれを通す ---
_SECRET_KEY_HINTS = (
    "privatekey", "private_key", "secretkey", "secret_key", "mnemonic", "seedphrase", "seed_phrase",
    "walletauthtoken", "bearertoken", "basicauthtoken", "authorizationsignature", "apikey", "api_key",
    "apikeysecret", "walletsecret", "appsecret", "clientsecret", "authorizationprivatekey", "aws_secret_access_key",
)
_HASH_FIELDS = {"reference", "transaction", "transactionhash", "txhash", "tx_hash", "tx", "hash", "blockhash",
                "nonce", "expectednonce", "digest", "challengehash"}
_HEX32 = re.compile(r"\b0x[0-9a-fA-F]{64}\b")
_PEM = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")


_DROP_FIELDS = {"paymentoutput", "permit2authorization"}  # 支払い署名は中身ごと捨てる（src/guard/redact.ts と同じ）


def scrub(value: Any, key: str = "") -> Any:
    """鍵らしいフィールド名と、許可されていないフィールドの 32byte hex / PEM を伏せる。
    支払い署名（paymentOutput / permit2Authorization）は型にかかわらず中身ごと伏せる。"""
    if key and key.lower() in _DROP_FIELDS:
        return "[REDACTED]"
    if isinstance(value, str):
        k = re.sub(r"[^a-z_]", "", key.lower())
        if k and any(re.sub(r"[^a-z_]", "", h) in k for h in _SECRET_KEY_HINTS):
            return "[REDACTED]"
        if key.lower() in _HASH_FIELDS:
            return value
        if _HEX32.search(value) or _PEM.search(value):
            return "[REDACTED]"
        return value
    if isinstance(value, list):
        return [scrub(v, key) for v in value]
    if isinstance(value, dict):
        return {k: scrub(v, k) for k, v in value.items()}
    return value
