# cloudflare-cost-to-line

Cloudflare の利用料金を LINE に通知する、小さな TypeScript 製の Cloudflare Worker です。利用者ごとに、自分の Cloudflare アカウントと LINE 公式アカウントへデプロイします。

- 毎日、日本時間0時に当月の計上済み従量料金と月末の概算を通知します。
- Cloudflare の予算アラートメールを受信すると、API で累積従量料金を確認して LINE に通知します。同じ請求期間・閾値の通知は1回です。
- SQLite バックエンドの Durable Object に送信状態を保存し、一時的な失敗は同じ LINE Retry-Key で最大23時間再試行します。

## 料金と集計の範囲

Cloudflare の利用料金と予算アラートは日次処理です。**10ドルに到達した瞬間の通知には対応しません。** 前日の利用分が集計され、予算アラートメールが届いた後に処理を開始します。Cron の0時は実行予定時刻であり、LINE の到着時刻の保証ではありません。

料金データには [Billable Usage API v1](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v1/) を使います。対象は self-serve アカウントの従量料金で、固定料金・税・クレジット・過去請求の訂正を含む確定支払総額ではありません。Enterprise 契約は対象外です。

通知する年月は `TIME_ZONE` で決め、料金の集計日は API の UTC 日付で扱います。日次通知は暦月、アラートは Cloudflare の請求期間を対象にするため、両者の金額が一致しないことがあります。

月末の概算は「当月の計上額＋直近7日の日平均費用×未集計分を含む残り日数」で計算します。無料枠の将来超過・段階課金・利用急増は正確に予測できません。データが不足している場合や費用がすべて0の場合は、予測を算出不可として表示します。固定費を設定した場合は別行で表示し、概算に月額分を1回加算します。

## 準備

1. Node.js 24 以降と npm を用意し、`npm ci` を実行します。
2. Cloudflare で対象アカウントに限定した `Billing Read` トークンを作成します。デプロイ用トークンは別に用意し、対象アカウントの Workers Scripts の編集に必要な権限を与えます。
3. LINE 公式アカウントで Messaging API を有効にし、チャネルアクセストークンを発行します。通知先の本人は公式アカウントを友だち追加し、[Messaging API のユーザーID](https://developers.line.biz/ja/docs/messaging-api/getting-user-ids/)を確認します。通常の LINE ID とは異なります。
4. GitHub の公開リポジトリにソースを置き、Settings → Environments で `production` を作成します。

LINE は既存アカウントも使えます。グループに送る場合は公式アカウントのグループ参加を許可して招待し、[グループID](https://developers.line.biz/ja/docs/messaging-api/group-chats/)を通知先に設定してください。このリポジトリは LINE の受信 Webhook を提供しません。

## GitHub の設定

`production` Environment に次の Variables を登録します。個人の値をソースへ書き込む必要はありません。

- `WORKER_NAME`：Worker 名。省略時は `cloudflare-cost-to-line`。
- `TIME_ZONE`：通知年月のタイムゾーン。省略時は `Asia/Tokyo`。
- `DAILY_CRON`：UTC の1日1回の Cron。省略時は `0 15 * * *`。タイムゾーンを変える場合はこの時刻も別途合わせます。
- `ALERT_THRESHOLD_USD`：累積従量料金の閾値。省略時は `10`。Cloudflare の予算アラートと同じ値にします。
- `MONTHLY_FIXED_COST_USD`：日次通知に加える固定月額の補足。省略時は `0`。アラート判定には加算しません。

同じ Environment の Secrets に次の値を登録します。

- `CLOUDFLARE_ACCOUNT_ID`：対象アカウントの32桁のID。必須。公開 Actions ログでマスクするため Secrets に保存します。
- `CLOUDFLARE_API_TOKEN`：デプロイ用トークン。Worker の実行時には渡しません。
- `BILLING_API_TOKEN`：料金参照専用トークン。
- `LINE_CHANNEL_ACCESS_TOKEN`：Messaging API の送信トークン。
- `LINE_RECIPIENT_ID`：本人のユーザーID、または参加済みグループID。
- `ALERT_EMAIL_RECIPIENT`：予算アラート専用の受信メールアドレス。
- `ALERT_EMAIL_SENDER`：実際の予算アラートメールの From メールアドレス。表示名は含めません。
- `ALERT_EMAIL_SUBJECT`：実際の予算アラートメールの件名。デコード後の完全一致で判定します。

メール関連の3項目は、すべて設定するか、すべて未設定にします。未設定なら日次通知だけを運用できます。

既に有効なメール通知を無効にする場合は、GitHub の3項目に加えて、Workers 側の同名の3つの Secrets も削除します。デプロイ時に省略した既存の Secrets は Cloudflare 側で保持されます。

実行時の認証情報と LINE・メールの設定は GitHub からデプロイ時に Workers Secrets へ反映します。デプロイ workflow 内で一時ファイルを権限600で作成し、終了時に削除します。秘密値を含む設定ファイルや、GitHub の個人設定をリポジトリに追加しないでください。

## メール受信とデプロイ

[Cloudflare Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) は Pay-as-you-go アカウントの累積従量料金を対象にします。現在の契約で利用できることを確認してください。

1. まず予算アラートを設定し、本人のメールアドレスで届くメールの From と件名を確認します。前節の Secrets に登録します。契約や通知形式の変化で件名が変わった場合は設定を更新します。
2. Cloudflare DNS 管理の独自ドメイン、または専用サブドメインで [Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/) を設定します。既存のメール配送を壊さないよう、必要な MX 設定を確認してください。
3. main ブランチの GitHub Actions → Deploy → Run workflow を実行します。CI は型チェックとビルドのみで、デプロイは手動です。
4. Email Routing の専用アドレスから、この Worker へ送るルールを設定します。Catch-all は不要です。
5. Cloudflare の予算アラートの通知先に、その専用アドレスを追加します。閾値を `ALERT_THRESHOLD_USD` と合わせます。

メール受信で Worker が起動するので、アラートのための定期ポーリングは行いません。メールは未信頼の起動契機として扱い、From・件名だけで課金超過とは判断しません。受信後に Billing API の現在・直前の請求期間を確認し、閾値以上の未通知期間を LINE に通知します。期間の最終日の超過通知が翌日に届いても、直前期間を確認できます。メール本文は LINE に送信しません。メールと API の反映時刻がずれた場合も、最大23時間は確認を再試行します。128KiB を超えるメールや、設定と一致しないメールは拒否します。

API v1 が返す USD・UTC 日次明細を対象に、月次の起算日で期間を区切ります。複数の異なる起算日を持つ契約のアラート合算には対応していません。日次の暦月集計は利用できます。

既通知の前期間と、API がまだ反映していない現在期間のメールを区別できないため、受信後の金額確認は既通知の場合も最大23時間続きます。新しいメールを受信すると確認を再開し、確認期限を受信から23時間に更新します。進行中の LINE 送信の再試行期限は延長しません。受理されたか不明な送信の重複を防ぐため、再試行期限を超えた同じ期間・閾値の通知は再送しません。

独自ドメインがない場合も日次通知は運用できます。このメール経由のアラートを有効にするには、ドメインと Email Routing の設定が必要です。

## ローカルでの確認

- `npm run check`：TypeScript の型チェック。
- `npm run build`：外部へデプロイしないビルド確認。
- `npm run dev`：ローカル Worker を起動。Cron は `/cdn-cgi/local/scheduled` で実行できます。呼び出しで実際の LINE 送信が起きるため、接続設定を用意した場合は検証用の通知先を使ってください。

個人設定なしで型チェックとビルドができます。実サービスへの疎通には前述の設定が必要です。設定の項目だけを示した `env.example` を用意しています。値をモデル・会話・公開ログに貼り付ける必要はありません。

通常の HTTP エンドポイントは404を返します。本番の `workers.dev` とプレビューURLは無効にし、Cron・Email Routing と内部の Durable Object だけで実行します。

LINE の HTTP 200 は API の受理を意味します。ブロックなどによる端末への未配信までは検知できません。[日本の無料プランは月200通](https://developers.line.biz/ja/docs/messaging-api/pricing/)で、同じ公式アカウントの他の配信も合算されます。処理エラーは個人設定や外部応答の本文を記録せず、固定メッセージと HTTP ステータスで通知の原因を確認できるようにします。

MIT License。
