"""AC-2: AgentCore Observability（vended logs / metrics）に出た項目名を集める。

docs（payments-observability.html, observability-payments-metrics.html, 2026-10-20 時点）で分かっていること:
  - vended logs は既定のロググループが無い。利用者がロググループを作り、PaymentManager ARN を source に
    PutDeliverySource(logType=APPLICATION_LOGS) → PutDeliveryDestination → CreateDelivery でつなぐ
  - ログのフィールド名は docs に無い → ここで実物から取る
  - メトリクス名: OperationSuccess / OperationFailure / OperationLatency / SpendAmount / Throttles / UserErrors /
    ActiveSessions / PaymentRequestCount / PaymentSuccessCount / PaymentFailureCount / PaymentLatency
  - ディメンション: Operation, PaymentManagerId, PaymentConnectorId, AgentName, Currency
  - 名前空間は payments のページに明記が無い（AgentCore 全般は AWS/Bedrock-AgentCore）→ ここで実物から取る

使い方:
  python scripts/ac2/cloudwatch.py --setup     # ロググループと delivery を作る（AC-2 の実払いの前に 1 回）
  python scripts/ac2/cloudwatch.py --collect   # 実払いの後に、メトリクス名とログのフィールド名を集める
要: AGENTCORE_PAYMENT_MANAGER_ARN, AWS_REGION。IAM は infra/iam/caller-permissions.json の Observability の節。

値は残さない。残すのは名前空間・メトリクス名・ディメンション名・ログのキー名（と件数）だけ。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Set

import boto3

LOG_GROUP = os.environ.get("AC2_LOG_GROUP", "/bedrock-agentcore/payments/buyer-harness")
NAME = "buyer-harness-payments"


def manager_arn() -> str:
    arn = os.environ.get("AGENTCORE_PAYMENT_MANAGER_ARN")
    if not arn:
        sys.exit("AGENTCORE_PAYMENT_MANAGER_ARN が要る")
    return arn


def setup(region: str) -> Dict[str, Any]:
    logs = boto3.client("logs", region_name=region)
    out: Dict[str, Any] = {"logGroup": LOG_GROUP}
    try:
        logs.create_log_group(logGroupName=LOG_GROUP)
        out["create_log_group"] = "created"
    except logs.exceptions.ResourceAlreadyExistsException:
        out["create_log_group"] = "exists"
    group_arn = logs.describe_log_groups(logGroupNamePrefix=LOG_GROUP)["logGroups"][0]["arn"].removesuffix(":*")
    src = logs.put_delivery_source(name=NAME, resourceArn=manager_arn(), logType="APPLICATION_LOGS")
    dst = logs.put_delivery_destination(
        name=NAME, deliveryDestinationConfiguration={"destinationResourceArn": group_arn}
    )
    try:
        d = logs.create_delivery(
            deliverySourceName=NAME, deliveryDestinationArn=dst["deliveryDestination"]["arn"]
        )
        out["delivery"] = d["delivery"]["id"]
    except logs.exceptions.ConflictException:
        out["delivery"] = "exists"
    out["deliverySource"] = src["deliverySource"]["name"]
    return out


def flatten_keys(obj: Any, prefix: str = "") -> Set[str]:
    keys: Set[str] = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{prefix}.{k}" if prefix else k
            keys.add(p)
            keys |= flatten_keys(v, p)
    elif isinstance(obj, list):
        for v in obj[:3]:
            keys |= flatten_keys(v, f"{prefix}[]")
    return keys


def collect(region: str, minutes: int) -> Dict[str, Any]:
    arn = manager_arn()
    manager_id = arn.rsplit("/", 1)[-1]
    cw = boto3.client("cloudwatch", region_name=region)
    logs = boto3.client("logs", region_name=region)

    # 名前空間を決め打ちしない: PaymentManagerId ディメンションで全名前空間から引く
    metrics: Dict[str, Dict[str, Set[str]]] = {}
    paginator = cw.get_paginator("list_metrics")
    for page in paginator.paginate(Dimensions=[{"Name": "PaymentManagerId", "Value": manager_id}]):
        for m in page["Metrics"]:
            ns = metrics.setdefault(m["Namespace"], {})
            ns.setdefault(m["MetricName"], set()).update(d["Name"] for d in m.get("Dimensions", []))
    # ディメンションに PaymentManagerId を持たないもの（ActiveSessions 等）も拾う
    for ns in list(metrics.keys()) or ["AWS/Bedrock-AgentCore"]:
        for page in paginator.paginate(Namespace=ns):
            for m in page["Metrics"]:
                if m["MetricName"].startswith(("Payment", "Spend", "ActiveSessions", "Operation", "Throttles", "UserErrors")):
                    metrics.setdefault(ns, {}).setdefault(m["MetricName"], set()).update(
                        d["Name"] for d in m.get("Dimensions", [])
                    )

    # ログ: 直近 N 分のイベントのキー名
    start = int((time.time() - minutes * 60) * 1000)
    keys: Dict[str, int] = {}
    n = 0
    groups = [LOG_GROUP] + [
        g["logGroupName"]
        for g in logs.describe_log_groups(logGroupNamePrefix="/aws/vendedlogs/bedrock-agentcore").get("logGroups", [])
    ]
    found_groups = []
    for g in groups:
        try:
            ev = logs.filter_log_events(logGroupName=g, startTime=start, limit=200).get("events", [])
        except logs.exceptions.ResourceNotFoundException:
            continue
        if ev:
            found_groups.append(g)
        for e in ev:
            n += 1
            try:
                for k in flatten_keys(json.loads(e["message"])):
                    keys[k] = keys.get(k, 0) + 1
            except json.JSONDecodeError:
                keys["<non-json message>"] = keys.get("<non-json message>", 0) + 1

    return {
        "collectedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "paymentManagerId": manager_id,
        "metrics": {ns: {name: sorted(dims) for name, dims in sorted(v.items())} for ns, v in metrics.items()},
        "log_groups_with_events": found_groups,
        "log_events_scanned": n,
        "log_field_names": dict(sorted(keys.items())),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--setup", action="store_true")
    ap.add_argument("--collect", action="store_true")
    ap.add_argument("--minutes", type=int, default=120)
    ap.add_argument("--out", default="artifacts/ac2/cloudwatch.json")
    args = ap.parse_args()
    region = os.environ.get("AWS_REGION", "us-east-1")
    result: Dict[str, Any] = {}
    if args.setup:
        result["setup"] = setup(region)
    if args.collect:
        result.update(collect(region, args.minutes))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    prev = json.loads(out.read_text()) if out.exists() else {}
    prev.update(result)
    out.write_text(json.dumps(prev, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2)[:2000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
