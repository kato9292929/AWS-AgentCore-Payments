export type Rail = "x402" | "mpp";

/** discover がモデルに返す候補。鍵・署名は含めない。 */
export interface Candidate {
  endpoint: string;
  /** 表示用の価格（USD 文字列）。 */
  price: string;
  /** 価格の atomic 表現（内部判定用。モデルに返す JSON にも入るが秘密ではない）。 */
  priceAtomic: string;
  rail: Rail;
  /** 402 が提示した支払い手段の要約。 */
  accepts: AcceptSummary[];
  description?: string;
  /** 価格の出所。402 を実際に叩いたのか、ディレクトリの記載なのか。 */
  priceSource: "402-probe" | "directory";
}

export interface AcceptSummary {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
}

/** 402 応答から取り出した支払い要求（レール非依存の共通形）。 */
export interface PaymentDemand {
  rail: Rail;
  scheme: string;
  network: string;
  /** atomic 単位。上限判定はこの値だけを見る。 */
  amountAtomic: bigint;
  asset: string;
  payTo: string;
  /** レール固有の生データ。ProcessPayment にそのまま渡す。 */
  raw: X402Raw | MppRaw;
}

export interface X402Raw {
  kind: "x402";
  x402Version: number;
  /** 402 body の accepts から選んだ 1 件。 */
  requirements: Record<string, unknown>;
  /** 402 body 全体。ログ用。 */
  body: Record<string, unknown>;
}

export interface MppRaw {
  kind: "mpp";
  /** WWW-Authenticate: Payment ... の生ヘッダ値（verbatim）。 */
  wwwAuthenticate: string;
  /** デコード済みの challenge パラメータ。ログ用。 */
  challenge: Record<string, string>;
  /** base64url デコードした request オブジェクト。ログ用。 */
  request: Record<string, unknown>;
}

export type Decision =
  | { verdict: "within" }
  | { verdict: "limit_exceeded"; reason: string; detail: Record<string, string> }
  | { verdict: "needs_approval"; reason: "first_time_endpoint" | "over_per_call_limit"; detail: Record<string, string> };

/** pay がモデルに返す形。receipt 概要と status のみ。 */
export type PayResult =
  | {
      status: "success";
      receipt: Receipt;
    }
  | {
      status: "declined";
      reason: string;
      detail?: Record<string, string>;
    }
  | {
      status: "needs_approval";
      reason: string;
      detail?: Record<string, string>;
    }
  | {
      status: "error";
      reason: string;
    };

export interface Receipt {
  /** testnet の tx hash / receipt id。 */
  reference: string;
  amount: string;
  asset: string;
  network: string;
  payTo: string;
  rail: Rail;
  timestamp: string;
  /** proof を生成したのが誰か。agentcore か local-signer か。 */
  proofSource: "agentcore" | "local-signer";
  /** 実マネーでないことを機械可読で残す。 */
  testnet: true;
  /** 相手が本物の公開エンドポイントか、ローカルの模擬売り手か。 */
  merchant: "live" | "mock-local";
}
