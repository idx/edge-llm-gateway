# edge-llm-gateway

LiteLLM の前段に置く Cloudflare Workers 製 API ゲートウェイ。Bearer トークン認証でリクエストを検証し、通過したものを LiteLLM へプロキシする。

```
Client ──→ Cloudflare Worker (認証) ──→ LiteLLM ──→ LLM Provider
```

## Features

- Bearer トークン認証（401 レスポンスに詳細を含めない列挙攻撃防止設計）
- LiteLLM への透過プロキシ（ボディ・Content-Type をそのまま転送）
- LiteLLM 障害時の 502 返却
- Cloudflare Workers (V8 isolate) ネイティブ実装 — Node.js 依存なし

## API

| 項目 | 値 |
|---|---|
| Method | `POST` |
| Path | `/v1/chat/completions` |
| 認証 | `Authorization: Bearer <CLIENT_API_KEY>` |
| Body | OpenAI 互換 JSON |

## Setup

### 必要なもの

- Node.js 22+
- Wrangler CLI (`npm install` で取得済み)
- Cloudflare アカウント

### インストール

```bash
npm install
```

### シークレット設定

```bash
npx wrangler secret put CLIENT_API_KEY   # クライアント認証トークン
npx wrangler secret put LITELLM_URL      # 例: https://litellm.example.com
```

> **注意:** シークレットは `wrangler.jsonc` の `[vars]` に書かず、必ず `wrangler secret put` を使うこと。

## Development

### ローカル起動

LiteLLM を Docker で起動してから Worker を起動する。

```bash
# LiteLLM 起動 (モックレスポンス設定済み)
docker compose up -d

# Worker 起動 (別ターミナル)
npx wrangler dev
```

動作確認:

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "hello"}]}'
```

### テスト

```bash
npx vitest run          # 全テスト
npx tsc --noEmit        # 型チェック
```

## Deploy

```bash
npx wrangler deploy
```

GitHub Actions (`deploy.yml`) により `main` ブランチへの push で自動デプロイされる。`CLOUDFLARE_API_TOKEN` を GitHub シークレットに設定すること。

## CI

| ワークフロー | トリガー | 内容 |
|---|---|---|
| `ci.yml` | push / PR → main | 型チェック・テスト |
| `deploy.yml` | push → main | Cloudflare Workers へデプロイ |

## Project Structure

```
src/
  index.ts          # Worker エントリポイント (認証 + プロキシ)
test/
  index.test.ts     # 全テスト (17件)
  env.d.ts          # テスト用型拡張
.github/workflows/
  ci.yml
  deploy.yml
wrangler.jsonc      # Wrangler 設定
litellm-config.yaml # LiteLLM モック設定 (開発用)
docker-compose.yaml # LiteLLM ローカル起動用
```
