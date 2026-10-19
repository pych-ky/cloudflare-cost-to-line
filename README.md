# cloudflare-cost-to-line

Cloudflare の当月従量料金と月末予測を、日次・手動で LINE に通知する。
既定の日次通知は日本時間0時。

GitHub Actions から Cloudflare Workers へデプロイする。
[Workers Free 対応](https://developers.cloudflare.com/durable-objects/platform/pricing/)だが、費用は利用量・契約プランに依存する。

## 設定

GitHub の `production` Environment に以下を登録し、許可ブランチを `main` のみにする。

### Secrets

- `CLOUDFLARE_ACCOUNT_ID`
  - 対象アカウントのID（32桁の16進表記）
- `CLOUDFLARE_API_TOKEN`
  - デプロイ用トークン
  - 初回は `Workers Admin`、以降は対象 Worker の `Individual Workers Editor`
- `BILLING_API_TOKEN`
  - 料金参照用トークン
  - 対象アカウントの `Billing Read`
- `LINE_CHANNEL_ACCESS_TOKEN`
  - LINE Messaging API の[チャネルアクセストークン](https://developers.line.biz/en/docs/basics/channel-access-token/#long-lived-channel-access-token)
- `LINE_RECIPIENT_ID`
  - 友だち追加済みの[ユーザーID](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)／公式アカウント参加済みの[グループID](https://developers.line.biz/en/docs/messaging-api/group-chats/)
  - 通常の LINE ID とは異なり、`U`・`C`・`R`＋32桁の16進表記
  - グループIDの取得には Webhook 受信が必要
  - 本 Worker は受信機能を持たないため別途用意する

### Variables（任意）

括弧内は既定値を示す。

- `WORKER_NAME`
  - デプロイする Worker 名（`cloudflare-cost-to-line`）
  - 変更すると別 Worker を対象にする
  - 旧 Worker の Cron は残り、新規作成には対応する権限が必要
- `TIME_ZONE`
  - 集計月・通知日付のタイムゾーン（`Asia/Tokyo`）
- `DAILY_CRON`
  - UTCで1日1回の通知時刻（`0 15 * * *`）
  - `TIME_ZONE` と独立し、重複判定は現地日付単位
  - 夏時間切り替え時は通知の省略や日付の飛びがありうる
- `MONTHLY_FIXED_COST_USD`
  - 月末予測に加える月額固定費（`0` USD）

## 実行

GitHub Actions で `main` を対象に手動実行する。

- Deploy
  - コード・Secrets・Variables を反映
  - 変更時は再実行する
- Send cost notification now
  - GitHub の設定を使い Actions 上で毎回送信する
  - Deploy 前でも実行可能
  - 日次の重複判定とは独立し、Worker・Cron の稼働確認にはならない

## 通知内容

```text
Cloudflare 2026-01 料金

当月の従量料金: $3.21 USD
月末予測: 約 $7.10 USD

データ対象: 2026-01-14 UTC まで
※予測は概算です。無料枠超過・税・クレジットは未反映。
```

- 手動通知は先頭に実行日時を付ける
- 欠測・取得失敗時は料金を「不明」、予測を「算出不可」とし、理由を表示する
- 欠測時は取得分の小計も併記する
- 料金APIの対象外で、契約・対象期間の明細がともに空と確認できた場合は「0ドル」「算出不可（日別データなし）」と判定根拠を表示する

## ローカル実行

Node.js 24以上・npm 11.16.0以上が必要。
リポジトリ直下の `.dev.vars` に設定する（`CLOUDFLARE_ACCOUNT_ID` は `ACCOUNT_ID` に読み替える）。

```dotenv
ACCOUNT_ID=<Cloudflare アカウントID>
BILLING_API_TOKEN=<料金参照用トークン>
LINE_CHANNEL_ACCESS_TOKEN=<LINE 送信用トークン>
LINE_RECIPIENT_ID=<通知先ID>
```

```sh
npm ci --engine-strict --strict-allow-scripts
npm run dev
```

起動後、別のターミナルから日次処理を実行する。

```sh
curl http://localhost:8787/cdn-cgi/local/scheduled
```

実際に LINE へ送信するため、検証用宛先を使う。
`.wrangler/state/` に状態を保存し、同日の処理中・送信済み通知は再起動後も抑止する。

## 通知の制約

- 集計
  - [Billable Usage API v1（Alpha）](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v1/)の従量料金（USD・UTC 日次明細）
  - [従量課金（Pay-as-you-go）対象、企業向け個別契約（Enterprise）対象外](https://developers.cloudflare.com/billing/manage/billable-usage/)
  - 税・クレジット・請求訂正込みの確定支払額とは異なる
- 月末予測
  - 計上額＋直近7日平均×残日数（未集計分含む）＋設定固定費
  - 欠測・連続7日分未満・直近7日0ドルなら「算出不可」
  - 無料枠超過・段階課金・急増は正確に予測できない
- 再試行
  - 一時的な料金取得失敗は最大2回
  - LINE の通信失敗・HTTP 429・5xxは、日次はジョブ作成から最大23時間、手動は最大2回
  - 受理済みの再送は成功扱い
  - 再試行対象外・期限切れの日次ジョブは破棄する
- 成功
  - LINE API の受理（端末到着は保証外）
- LINE の通数
  - グループも含め受信者数で計算される
  - 無料枠は[LINE の料金プラン](https://developers.line.biz/en/docs/messaging-api/pricing/)による
