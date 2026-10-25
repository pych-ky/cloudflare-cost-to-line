# cloudflare-cost-to-line

Cloudflare の当月従量料金・月末予測を LINE に日次・手動通知する[Workers Free 対応](https://developers.cloudflare.com/durable-objects/platform/pricing/)の Worker。

## 設定

GitHub の `production` Environment に登録し、許可ブランチを `main` のみにする。
main の保護ルールでは GitHub Actions の `check` 成功を必須にする。

### Secrets

- `CLOUDFLARE_ACCOUNT_ID`: 対象アカウントID（32桁の16進表記）
- `CLOUDFLARE_API_TOKEN`: 初回は `Workers Admin`、以降は対象 Worker の `Individual Workers Editor`
- `BILLING_API_TOKEN`: 対象アカウントの `Billing Read`
- `LINE_CHANNEL_ACCESS_TOKEN`: [チャネルアクセストークン](https://developers.line.biz/en/docs/basics/channel-access-token/#long-lived-channel-access-token)
- `LINE_RECIPIENT_ID`: 友だち追加済みの[ユーザーID](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)／公式アカウント参加済みの[グループID](https://developers.line.biz/en/docs/messaging-api/group-chats/)

通知先は通常の LINE ID ではなく、`U`・`C`・`R`＋32桁の16進表記。
グループID取得用の Webhook 受信機能は別途用意する。

### Variables（任意）

[wrangler.json](wrangler.json) の既定値を上書きする場合に登録する。

- `WORKER_NAME`: デプロイ先
- `TIME_ZONE`: 集計月・通知日付のタイムゾーン
- `DAILY_CRON`: UTCで1日1回の通知時刻
- `MONTHLY_FIXED_COST_USD`: 予測に加える月額固定費（USD）

Worker 名を変えても旧 Worker の Cron は残る。

通知時刻は `TIME_ZONE` と独立し、重複判定は現地日付単位。
夏時間切り替え時は通知の省略や日付の飛びがありうる。

## 実行

main へのマージ後、CI の検証成功に続いて同じコミットを本番へ自動反映する。
この CI では、実行対象のコミットが最新 main と一致しなければデプロイを見送る。
再デプロイには最新の CI を使い、旧 Deploy の実行履歴を再実行しない。

設定変更は [wrangler.json](wrangler.json) または GitHub の `production` Environment で行う。
通常のコード・設定・Secrets 更新では Cloudflare Dashboard から Worker を編集しない。
Dashboard で編集すると、次回 Wrangler デプロイの設定比較に追加の読み取り権限が必要になる場合がある。

GitHub Actions で `main` を対象に手動実行する場合:

- CI: GitHub の設定・Secrets 変更後の反映や再デプロイ。失敗時の API 診断は `debug` を有効にする
- Send cost notification now: デプロイ不要で GitHub の設定から毎回送信

CI は反映後の稼働版100%・Cron・設定を照合し、結果を Summary と `deployment-after-実行ID-試行番号` Artifact に残す。
反映後の照合失敗は本番へのアップロードを取り消さないため、記録した版とエラーを確認する。
課金APIの取得・LINE配信の成功までは確認しない。

手動通知は日次の重複判定とは独立する。
Worker・Cron の稼働確認にはならない。

### コードの復旧

CI のデプロイは稼働版を `deployment-before-実行ID-試行番号` Artifact に保存できなければ停止する。
復旧用の Artifact は14日間保持する。

1. 対象 Artifact の `deployment-before.json` で `worker_name` を確認する。
2. Cloudflare Dashboard の対象アカウントの Worker → Deployments で、`deployment.versions` の `version_id` から正常な版を選び、Rollback する。
   複数版の稼働時も、選んだ版が100%を担う。

`deployment: null` は初回のため復旧先なし。
Durable Object の保存状態・送信済み通知・GitHub Secrets は戻らない。
Secrets 変更や Durable Object 移行による[復旧制限](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#limits)で拒否された場合は、強制せず現在の設定・データと互換な修正を再デプロイする。

## 料金・通知

```text
Cloudflare 2026-01 料金

当月の従量料金: $3.21 USD
月末予測: 約 $7.10 USD

データ対象: 2026-01-14 UTC まで
※予測は概算です。無料枠超過・税・クレジットは未反映。
```

料金は [Billable Usage API v1（Alpha）](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v1/)の USD・UTC 日次明細で、[従量課金が対象、企業向け個別契約（Enterprise）は対象外](https://developers.cloudflare.com/billing/manage/billable-usage/)。
税・クレジット・請求訂正込みの確定支払額とは異なる。

月末予測は計上額＋直近7日平均×残日数（未集計分含む）＋設定固定費。
無料枠超過・段階課金・急増は正確に予測できない。

API対象外では、契約・対象期間の明細がともに空と確認できた場合だけ0ドルと判定する。

### 配信

- 再試行: LINE の通信失敗・HTTP 429・5xxを、日次はジョブ作成から最大23時間、手動は最大2回
- 成功: LINE API の受理・受理済み応答
- 通数: グループも受信者数で計算（[料金プラン](https://developers.line.biz/en/docs/messaging-api/pricing/)）

端末到着は保証しない。

## ローカル実行

Node.js・npm の要件は [engines](package.json) を参照する。
リポジトリ直下の `.dev.vars` に `CLOUDFLARE_API_TOKEN` 以外の Secrets を設定する。
`CLOUDFLARE_ACCOUNT_ID` は `ACCOUNT_ID` に読み替える。

```sh
npm ci --engine-strict --strict-allow-scripts
npm run dev
```

起動後、別のターミナルで日次処理を実行する。

```sh
curl http://localhost:8787/cdn-cgi/local/scheduled
```

実際に LINE へ送信するため、検証用宛先を使う。
`.wrangler/state/` に状態を保存し、同日の処理中・送信済み通知は再起動後も抑止する。

### 依存関係の更新

`npm ci --engine-strict --strict-allow-scripts` を維持し、Dependabot PR でも更新差分とインストールスクリプトを都度確認する。
`ESTRICTALLOWSCRIPTS` の場合は `npm install-scripts ls` で未判断のパッケージを確認し、必要性と内容を確認してから `allowScripts` を対象バージョン限定で同じ PR 内に更新する。
Wrangler とその依存も同じ扱いとし、パッケージ単位の恒常的な許可や検査の無効化は行わない。
