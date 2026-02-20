# Edge LLM Gateway

LiteLLM の前段に置く Cloudflare Workers 製 API ゲートウェイ。Bearer トークン認証でリクエストを検証し、通過したものを LiteLLM へプロキシする。

```
Client ─→ Cloudflare Worker (認証) ─→ LiteLLM ─→ LLM Provider
```

Worker の責務: 認証とプロキシのみ。レート制限・ログ永続化・ボディ変更・キャッシュ・マルチテナントは行わない。

## Tech Stack

- Cloudflare Workers (ES modules format)
- TypeScript strict
- Wrangler CLI
- Vitest + `@cloudflare/vitest-pool-workers`

## Commands

```bash
npx wrangler dev                    # ローカル起動
npx vitest run                      # 全テスト
npx vitest run src/auth.test.ts     # 単一テスト
npx tsc --noEmit                    # 型チェック
npx wrangler deploy                 # デプロイ
```

コード変更後は `npx tsc --noEmit && npx vitest run` を実行してから完了報告すること。

## Request Contract

- Method: `POST`
- Path: `/v1/chat/completions`
- Header: `Authorization: Bearer <CLIENT_API_KEY>`
- Body: OpenAI 互換 JSON

認証フロー:
1. `Authorization` ヘッダー存在チェック → なければ 401
2. `Bearer ` プレフィックスチェック → なければ 401
3. トークン === `CLIENT_API_KEY` → 不一致なら 401
4. 認証通過 → `LITELLM_URL` へリクエスト転送

## Workers Constraints

IMPORTANT: Workers は V8 isolate で動作する。Node.js ではない。

- `fs`, `path`, `net`, `child_process` 等の Node API は使えない
- `node:crypto`, `node:buffer` は `nodejs_compat` フラグ有効時のみ
- グローバル変数はリクエスト間で共有される可能性がある。YOU MUST NOT use module-level mutable state
- `Request`/`Response` は Web 標準 API。`new Response(body, init)` を使う
- レスポンスボディは一度しか読めない。再読する場合は `response.clone()` が必要
- バックグラウンド処理は `ctx.waitUntil(promise)` で延命する
- 環境変数は `process.env` ではなく `fetch(req, env)` の `env` 引数経由

## Code Patterns

Worker エントリポイント:

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  },
} satisfies ExportedHandler<Env>;
```

環境変数の型:

```typescript
interface Env {
  CLIENT_API_KEY: string;
  LITELLM_URL: string;
}
```

エラーレスポンス:

```typescript
// 認証エラーに詳細理由を含めない (列挙攻撃防止)
return new Response(JSON.stringify({ error: "Unauthorized" }), {
  status: 401,
  headers: { "Content-Type": "application/json" },
});
```

## Testing

`@cloudflare/vitest-pool-workers` で Workers ランタイム上でテスト実行する。

```typescript
// vitest.config.ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
  test: { poolOptions: { workers: { wrangler: { configPath: "./wrangler.toml" } } } },
});
```

テストでは `SELF.fetch()` で Worker にリクエストを送る:

```typescript
import { SELF } from "cloudflare:test";
const res = await SELF.fetch("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: "Bearer test-key" },
  body: JSON.stringify({ model: "gpt-4", messages: [] }),
});
expect(res.status).toBe(200);
```

テストすべきケース:
- Authorization ヘッダーなし → 401
- 無効トークン → 401
- 有効トークン → LiteLLM 転送 (fetch mock で検証)
- POST 以外 → 405
- 不正パス → 404
- LiteLLM ダウン → 502
- LiteLLM 500 → そのまま伝播

## Security

IMPORTANT: 以下は絶対に守ること。

- `.env*`, `*.key`, `*.pem`, `credentials.json` の読み書き禁止
- シークレットは `wrangler.toml` の `[vars]` に書かない。`wrangler secret put` を使う
- `CLIENT_API_KEY` をログ・レスポンス・エラーメッセージに含めない
- 認証失敗レスポンスに理由の詳細を含めない
- fail closed: 判断不能な状態ではリクエスト拒否

## Workflow

- ブランチ: `feature/<name>`, `fix/<name>`
- コミット: Conventional Commits
