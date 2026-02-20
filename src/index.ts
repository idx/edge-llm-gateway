function jsonResponse(body: Record<string, unknown>, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return jsonResponse({ error: "Method Not Allowed" }, 405);
		}

		const url = new URL(request.url);
		if (url.pathname !== "/v1/chat/completions") {
			return jsonResponse({ error: "Not Found" }, 404);
		}

		const authHeader = request.headers.get("Authorization");
		if (
			!authHeader ||
			!authHeader.startsWith("Bearer ") ||
			authHeader.slice(7) !== env.CLIENT_API_KEY
		) {
			return jsonResponse({ error: "Unauthorized" }, 401);
		}

		const targetUrl = `${env.LITELLM_URL}/v1/chat/completions`;
		try {
			return await fetch(targetUrl, {
				method: "POST",
				headers: {
					"Content-Type":
						request.headers.get("Content-Type") || "application/json",
				},
				body: request.body,
			});
		} catch {
			return jsonResponse({ error: "Bad Gateway" }, 502);
		}
	},
} satisfies ExportedHandler<Env>;
