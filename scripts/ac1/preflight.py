"""AC-1 実行前の資格情報の確認（手順 a）。

  1. sts:GetCallerIdentity        … 資格情報が有効か（アカウント ID は伏せて、主体の種類だけ残す）
  2. control plane の読み取り 1 回 … GetPaymentManager（AGENTCORE_PAYMENT_MANAGER_ARN の ID）
  3. （あれば）GetPaymentConnector … AGENTCORE_PAYMENT_CONNECTOR_ID が READY か

どれかが失敗したら、その時点のエラー（型・HTTP ステータス・メッセージ）をそのまま記録して終了コード 1 で止まる。
出力: artifacts/ac1/preflight.json。資格情報の値は読まない・残さない。

使い方:
  AWS_REGION=us-east-1 AGENTCORE_PAYMENT_MANAGER_ARN=... AGENTCORE_PAYMENT_CONNECTOR_ID=... \\
    python3 scripts/ac1/preflight.py
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict

import boto3
from botocore.exceptions import BotoCoreError, ClientError

OUT = Path(__file__).resolve().parents[2] / "artifacts" / "ac1" / "preflight.json"


def err(e: Exception) -> Dict[str, Any]:
    if isinstance(e, ClientError):
        meta = e.response.get("ResponseMetadata", {})
        return {
            "type": e.response.get("Error", {}).get("Code"),
            "httpStatus": meta.get("HTTPStatusCode"),
            "message": e.response.get("Error", {}).get("Message"),
            "operation": e.operation_name,
        }
    return {"type": type(e).__name__, "message": str(e)}


def main() -> int:
    region = os.environ.get("AWS_REGION", "us-east-1")
    arn = os.environ.get("AGENTCORE_PAYMENT_MANAGER_ARN", "")
    connector = os.environ.get("AGENTCORE_PAYMENT_CONNECTOR_ID")
    rec: Dict[str, Any] = {"checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "region": region, "steps": []}

    def step(name: str, fn) -> bool:
        try:
            r = fn()
            rec["steps"].append({"step": name, "ok": True, **r})
            return True
        except (ClientError, BotoCoreError) as e:
            rec["steps"].append({"step": name, "ok": False, "error": err(e)})
            return False

    def sts() -> Dict[str, Any]:
        i = boto3.client("sts", region_name=region).get_caller_identity()
        # アカウント ID とユーザー名は残さない（主体の種類だけ）
        return {"principalType": i["Arn"].split(":")[5].split("/")[0]}

    def manager() -> Dict[str, Any]:
        if not arn:
            raise BotoCoreError()  # 下で理由を上書きする
        m = boto3.client("bedrock-agentcore-control", region_name=region).get_payment_manager(paymentManagerId=arn.rsplit("/", 1)[-1])
        return {"paymentManagerStatus": m.get("status"), "authorizerType": m.get("authorizerType")}

    def conn() -> Dict[str, Any]:
        c = boto3.client("bedrock-agentcore-control", region_name=region).get_payment_connector(
            paymentManagerId=arn.rsplit("/", 1)[-1], paymentConnectorId=connector
        )
        return {"paymentConnectorStatus": c.get("status"), "type": c.get("type"), "provisionMode": c.get("provisionMode")}

    ok = step("sts:GetCallerIdentity", sts)
    if ok:
        if not arn:
            rec["steps"].append({"step": "GetPaymentManager", "ok": False, "error": {"message": "AGENTCORE_PAYMENT_MANAGER_ARN が無い"}})
            ok = False
        else:
            ok = step("bedrock-agentcore-control:GetPaymentManager", manager)
    if ok and connector:
        ok = step("bedrock-agentcore-control:GetPaymentConnector", conn)
    rec["ok"] = ok
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(rec, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
