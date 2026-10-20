import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toCaip2 } from "../rails/caip2.js";
import type { PaymentDemand } from "../types.js";

/**
 * 支払い先の allowlist（AC-2）。
 *
 * AgentCore の SessionLimits は「いくらまで」しか縛れず、「誰に」は縛れない。
 * Strands プラグインの network_preferences_config も並べ替えのヒントでしかない。
 * そこで、署名（ProcessPayment）に進む前に payTo と network の組を設定ファイルと突き合わせる。
 * 一致しなければ決済に進まない（deny by default）。
 */

export interface PayToEntry {
  label: string;
  payTo: string;
  /** slug でも CAIP-2 でもよい。比較は CAIP-2 に寄せて行う。 */
  networks: string[];
}

export type PayToVerdict =
  | { allowed: true; entry: PayToEntry }
  | { allowed: false; reason: "payto_not_allowlisted" | "network_not_allowlisted_for_payto" };

export class PayToAllowlist {
  constructor(readonly entries: PayToEntry[]) {}

  static load(path = process.env["PAYTO_ALLOWLIST_PATH"] ?? "config/payto-allowlist.json"): PayToAllowlist {
    const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as { entries?: PayToEntry[] };
    return new PayToAllowlist(raw.entries ?? []);
  }

  check(demand: Pick<PaymentDemand, "payTo" | "network">): PayToVerdict {
    const hits = this.entries.filter((e) => e.payTo.toLowerCase() === demand.payTo.toLowerCase());
    if (hits.length === 0) return { allowed: false, reason: "payto_not_allowlisted" };
    const want = normalize(demand.network);
    const entry = hits.find((e) => e.networks.some((n) => normalize(n) === want));
    if (!entry) return { allowed: false, reason: "network_not_allowlisted_for_payto" };
    return { allowed: true, entry };
  }
}

function normalize(network: string): string {
  try {
    return toCaip2(network);
  } catch {
    // CAIP-2 に寄せられない表記は文字列のまま比べる（一致しなければ拒否側に倒れる）
    return network.trim().toLowerCase();
  }
}
