# cloudflare-cost-to-line

Cloudflare の当月従量料金・月末予測を LINE に日次・手動通知する[Workers Free 対応](https://developers.cloudflare.com/durable-objects/platform/pricing/)の Worker。

## 設定

- GitHub の `production` Environment に登録し、許可ブランチを `main` のみにする
- main の保護ルールでは GitHub Actions の `check` 成功を必須にする

### Secrets

- `CLOUDFLARE_ACCOUNT_ID`: 対象アカウントID（32桁の16進表記）
- `CLOUDFLARE_API_TOKEN`: 初回は `Workers Admin`、以降は対象 Worker の `Individual Workers Editor`
- `BILLING_API_TOKEN`: 対象アカウントの `Billing Read`
- `LINE_CHANNEL_ACCESS_TOKEN`: [チャネルアクセストークン](https://developers.line.biz/en/docs/basics/channel-access-token/#long-lived-channel-access-token)
- `LINE_RECIPIENT_ID`: 友だち追加済みの[ユーザーID](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)／公式アカウント参加済みの[グループID](https://developers.line.biz/en/docs/messaging-api/group-chats/)
  - グループID取得用の Webhook 受信機能は別途用意する

### Variables（任意）

[wrangler.json](wrangler.json) の既定値を上書きする場合に登録する。

- `WORKER_NAME`: デプロイ先
- `TIME_ZONE`: 集計月・通知日付のタイムゾーン
- `DAILY_CRON`: UTCで1日1回の通知時刻
- `MONTHLY_FIXED_COST_USD`: 予測に加える月額固定費（USD）

Worker 名を変えても旧 Worker の Cron は残る。
重複判定は `TIME_ZONE` の日付単位。
夏時間の切り替え時は通知の省略や日付の飛びがありうる。

## 実行

main へのマージ後、CI の検証成功に続いて同じコミットを本番へ自動反映する。

- 再デプロイには最新の CI を使う
- 旧 Deploy の実行履歴を再実行しない
- 設定変更は [wrangler.json](wrangler.json) または GitHub の `production` Environment で行う
- 通常のコード・設定・Secrets 更新では Cloudflare Dashboard から Worker を編集しない

Dashboard で編集すると、次回 Wrangler デプロイの設定比較に追加の読み取り権限が必要になる場合がある。

GitHub Actions の手動実行は `main` を対象にする。

- CI: GitHub の設定・Secrets 変更後の反映や再デプロイ
  - デプロイ失敗時は `debug` を有効にし、API 通信の診断ログを出す
- Send cost notification now: デプロイ不要で GitHub の設定から毎回送信

手動通知は日次の重複判定とは独立する。
Worker・Cron の稼働確認にはならない。

## 料金・通知

料金は [Billable Usage API v1（Alpha）](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v1/) の USD・UTC 日次明細。
[対象](https://developers.cloudflare.com/billing/manage/billable-usage/)は従量課金で、企業向け個別契約（Enterprise）は対象外。
税・クレジット・請求訂正込みの確定支払額とは異なる。

月末予測は計上額に直近7日平均×残日数と設定固定費を足した額。
残日数には未集計の日も含む。
無料枠超過・段階課金・急増は正確に予測できない。

LINE の[料金プラン](https://developers.line.biz/en/docs/messaging-api/pricing/)ではグループ宛ても受信者数で通数を数える。

## ローカル実行

- リポジトリ直下の `.dev.vars` に `CLOUDFLARE_API_TOKEN` 以外の Secrets を設定する
- `CLOUDFLARE_ACCOUNT_ID` は `ACCOUNT_ID` に読み替える
- 実際に LINE へ送信するため、検証用宛先を使う

```sh
npm ci --engine-strict --strict-allow-scripts
npm run dev
```

- 起動後、別のターミナルで日次処理を実行する

```sh
curl http://localhost:8787/cdn-cgi/local/scheduled
```

`.wrangler/state/` に状態を保存し、同日の処理中・送信済み通知は再起動後も抑止する。

## 依存関係の更新

- Dependabot PR でも更新差分とインストールスクリプトを確認する
- `ESTRICTALLOWSCRIPTS` の場合は `npm install-scripts ls` で未判断のパッケージを確認する
- 必要性と内容を確認してから、`allowScripts` を対象バージョン限定で同じ PR 内に更新する
- `--strict-allow-scripts` などの検査の無効化や、パッケージ単位の恒常的な許可は行わない
