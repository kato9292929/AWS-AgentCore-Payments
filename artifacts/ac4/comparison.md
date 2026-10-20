# AC-4 比較表（AgentCore 経由 / AA 列は空欄）

生成: 2026-10-20T17:44:53+09:00（scripts/ac4/normalize.ts）

```
売り手                 経路         提示額 USD(scheme)                       実費 USD(中央値) 上乗せ     失敗率   遅延ms(中央) AA  
---------------------- ------------ ---------------------------------------- ---------------- ---------- -------- ------------ ----
GoCreative             probe-only   HTTP 502                                 -                -          -        -                
2s                     probe-only   0.002500(exact),0.002500(upto)           未払い           -          -        -                
BlockRun               probe-only   0.002000(exact)                          未払い           -          -        -                
OneSource              probe-only   0.001000(exact),0.001000(batch-settlement) 未払い           -          -        -                
Otto AI                probe-only   0.001000(exact)                          未払い           -          -        -                
x402.org               probe-only   0.010000(exact)                          未払い           -          -        -                
```

- 提示額は 402 の額（upto は上限額）。実費は settle された額の中央値。上乗せ = 実費 − 提示額。
- probe-only の行は 402 を見ただけで支払っていない。
- AA 列は x402 Autonomous Agent 側のデータで埋める（このリポジトリの範囲外）。
