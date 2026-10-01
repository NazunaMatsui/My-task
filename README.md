# My-task（今日のリスト）

日付ごとのシンプルなToDoリスト。Cloudflare Workers + D1 で動きます。

- 今日のタスクの追加 / 完了 / 編集（タイトルをクリック）/ 削除
- 日付ごとに保存（‹ › で前後の日へ移動、日本時間基準）
- 前日の未完了タスクを今日へ繰り越し
- 複数端末で同期（D1に保存）

## 構成
- `src/index.js` … Worker（`/api/*` と静的配信、任意のパスワード認証）
- `public/` … フロント（HTML/CSS/JS）
- `migrations/` … D1 スキーマ

## 使い方
```sh
npm install
npm run db:migrate:local   # ローカルD1にテーブル作成
npm run dev                # http://localhost:8787
```

## デプロイ
D1（`my-task`）は作成・マイグレーション適用済み。
```sh
npx wrangler secret put APP_PASSWORD   # 推奨: 設定するとBasic認証で保護（ユーザー名は任意）
npm run deploy
```
`APP_PASSWORD` を設定しないと、URLを知っている人は誰でも閲覧・編集できます。

## 天気とニュース
- 天気: 姫路市・宍粟市・神戸市の今日の天気（[Open-Meteo](https://open-meteo.com/)、APIキー不要）。都市は `src/index.js` の `CITIES`。
- ニュース: エンタメ / IT / 政治・経済 / 恋愛 のタブ切り替え。配信元は `src/index.js` の `NEWS_CATEGORIES`（NHK・ITmedia・Googleニュース）。
- 取得に失敗してもリスト本体は通常どおり動きます。
