import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						CLIENT_API_KEY: "test-api-key",
						LITELLM_URL: "https://litellm.example.com",
					},
				},
			},
		},
	},
});
