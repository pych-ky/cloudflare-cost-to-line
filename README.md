# cloudflare-cost-to-line

Cloudflare の当月従量料金と月末予測を、毎日または手動で LINE に通知する。

## 設定

設定値は GitHub の `production` Environment に登録する。

### Secrets

- `CLOUDFLARE_ACCOUNT_ID`
  - 対象の Cloudflare アカウントID
- `CLOUDFLARE_API_TOKEN`
  - デプロイ用トークン。初回は `Workers Admin`、以降は対象 Worker の `Individual Workers Editor`
- `BILLING_API_TOKEN`
  - 料金参照用トークン。対象アカウントの `Billing Read`
- `LINE_CHANNEL_ACCESS_TOKEN`
  - LINE 送信用の Messaging API トークン
- `LINE_RECIPIENT_ID`
  - 友だち追加済みユーザー／公式アカウント参加済みグループのID（通常の LINE ID とは別）

### Variables（任意）

括弧内は既定値を示す。

- `WORKER_NAME`
  - デプロイする Worker 名（`cloudflare-cost-to-line`）
- `TIME_ZONE`
  - 集計期間・通知日付のタイムゾーン（`Asia/Tokyo`）
- `DAILY_CRON`
  - UTCで1日1回の通知時刻（`0 15 * * *`）。`TIME_ZONE` と独立
- `MONTHLY_FIXED_COST_USD`
  - 月末予測に加える月額固定費（`0` USD）

## 実行

GitHub Actions で `main` を対象に、次のワークフローを手動実行する。

- Deploy
  - コード・Secrets を反映
- Send cost notification now
  - 毎回送信。日次の重複判定とは独立し、Worker・Cron の検証には使えない

### 注意事項

`npm run dev` の `/cdn-cgi/local/scheduled` は接続設定があると実送信するため、検証用宛先を使う。

## 通知の制約

- 集計
  - Billable Usage API v1 の self-serve 従量料金（USD・UTC 日次明細）。税・クレジット・請求訂正込みの確定支払額とは異なる
- 月末予測
  - 計上額＋直近7日平均×残日数（未集計分含む）＋設定固定費。欠測・7日分未満・直近7日0ドルなら保留。無料枠超過・段階課金・急増は正確に予測できない
- 期間
  - `TIME_ZONE` の暦月
- 再試行
  - 一時的な取得失敗は2回再試行後に金額未確認として通知。LINE の一時失敗は最大23時間
- 成功
  - LINE API の受理（端末到着は保証外）
