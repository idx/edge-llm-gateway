import {
	SELF,
	fetchMock,
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import worker from "../src/index";

const ENDPOINT = "http://localhost/v1/chat/completions";
const VALID_HEADERS = { Authorization: "Bearer test-api-key" };
const VALID_BODY = JSON.stringify({
	model: "gpt-4",
	messages: [{ role: "user", content: "hello" }],
});

// LiteLLM mock setup
beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe("authentication", () => {
	it("rejects request without Authorization header", async () => {
		const res = await SELF.fetch(ENDPOINT, {
			method: "POST",
			body: VALID_BODY,
		});
		expect(res.status).toBe(401);
		const body = await res.json<{ error: string }>();
		expect(body.error).toBe("Unauthorized");
	});

	it("rejects request with invalid token", async () => {
		const res = await SELF.fetch(ENDPOINT, {
			method: "POST",
			headers: { Authorization: "Bearer wrong-key" },
			body: VALID_BODY,
		});
		expect(res.status).toBe(401);
	});

	it("rejects request without Bearer prefix", async () => {
		const res = await SELF.fetch(ENDPOINT, {
			method: "POST",
			headers: { Authorization: "test-api-key" },
			body: VALID_BODY,
		});
		expect(res.status).toBe(401);
	});

	it("rejects request with empty token", async () => {
		const res = await SELF.fetch(ENDPOINT, {
			method: "POST",
			headers: { Authorization: "Bearer " },
			body: VALID_BODY,
		});
		expect(res.status).toBe(401);
	});
});

describe("routing", () => {
	it("rejects non-POST method", async () => {
		const res = await SELF.fetch(ENDPOINT, {
			method: "GET",
			headers: VALID_HEADERS,
		});
		expect(res.status).toBe(405);
		const body = await res.json<{ error: string }>();
		expect(body.error).toBe("Method Not Allowed");
	});

	it("rejects unknown path", async () => {
		const res = await SELF.fetch("http://localhost/v1/models", {
			method: "POST",
			headers: VALID_HEADERS,
		});
		expect(res.status).toBe(404);
		const body = await res.json<{ error: string }>();
		expect(body.error).toBe("Not Found");
	});
});

describe("proxy", () => {
	it("forwards valid request to LiteLLM and returns response", async () => {
		const mockResponse = {
			id: "chatcmpl-123",
			choices: [{ message: { role: "assistant", content: "hi" } }],
		};

		fetchMock
			.get("https://litellm.example.com")
			.intercept({ path: "/v1/chat/completions", method: "POST" })
			.reply(200, JSON.stringify(mockResponse), {
				headers: { "content-type": "application/json" },
			});

		const res = await SELF.fetch(ENDPOINT, {
			method: "POST",
			headers: { ...VALID_HEADERS, "Content-Type": "application/json" },
			body: VALID_BODY,
		});

		expect(res.status).toBe(200);
		const body = await res.json<{ id: string }>();
		expect(body.id).toBe("chatcmpl-123");
	});

	it("forwards request body to LiteLLM unchanged", async () => {
		let capturedBody: string | null = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
			capturedBody = await new Response(init?.body).text();
			return new Response(JSON.stringify({ id: "chatcmpl-test" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const request = new Request(ENDPOINT, {
				method: "POST",
				headers: { ...VALID_HEADERS, "Content-Type": "application/json" },
				body: VALID_BODY,
			});
			const ctx = createExecutionContext();
			await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(capturedBody).toBe(VALID_BODY);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("uses application/json as default Content-Type when not provided", async () => {
		let capturedContentType: string | null = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
			capturedContentType =
				(init?.headers as Record<string, string>)?.["Content-Type"] ?? null;
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const request = new Request(ENDPOINT, {
				method: "POST",
				headers: VALID_HEADERS, // Content-Type なし
				// string を渡すと text/plain が自動付与されるため Uint8Array で渡す
				body: new TextEncoder().encode(VALID_BODY),
			});
			const ctx = createExecutionContext();
			await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(capturedContentType).toBe("application/json");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns 502 when LiteLLM is unreachable", async () => {
		// Direct handler call to avoid fetchMock unhandled rejection in Workers isolate
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockRejectedValue(
			new Error("Connection refused"),
		) as typeof fetch;

		try {
			const request = new Request(ENDPOINT, {
				method: "POST",
				headers: { ...VALID_HEADERS, "Content-Type": "application/json" },
				body: VALID_BODY,
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(res.status).toBe(502);
			const body = await res.json<{ error: string }>();
			expect(body.error).toBe("Bad Gateway");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("propagates LiteLLM 500 error as-is", async () => {
		fetchMock
			.get("https://litellm.example.com")
			.intercept({ path: "/v1/chat/completions", method: "POST" })
			.reply(500, JSON.stringify({ error: "Internal Server Error" }), {
				headers: { "content-type": "application/json" },
			});

		const res = await SELF.fetch(ENDPOINT, {
			method: "POST",
			headers: { ...VALID_HEADERS, "Content-Type": "application/json" },
			body: VALID_BODY,
		});

		expect(res.status).toBe(500);
	});
});

describe("security", () => {
	it("does not leak error details in 401 response", async () => {
		const res = await SELF.fetch(ENDPOINT, {
			method: "POST",
			headers: { Authorization: "Bearer wrong" },
			body: VALID_BODY,
		});
		const body = await res.json<Record<string, unknown>>();
		expect(Object.keys(body)).toEqual(["error"]);
		expect(body.error).toBe("Unauthorized");
	});

	it("returns Content-Type application/json for 401 error", async () => {
		const res = await SELF.fetch(ENDPOINT, {
			method: "POST",
			headers: { Authorization: "Bearer wrong" },
			body: VALID_BODY,
		});
		expect(res.headers.get("Content-Type")).toBe("application/json");
	});

	it("returns Content-Type application/json for 404 error", async () => {
		const res = await SELF.fetch("http://localhost/v1/models", {
			method: "POST",
			headers: VALID_HEADERS,
		});
		expect(res.headers.get("Content-Type")).toBe("application/json");
	});

	it("returns Content-Type application/json for 405 error", async () => {
		const res = await SELF.fetch(ENDPOINT, {
			method: "GET",
			headers: VALID_HEADERS,
		});
		expect(res.headers.get("Content-Type")).toBe("application/json");
	});

	it("returns Content-Type application/json for 502 error", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockRejectedValue(
			new Error("Connection refused"),
		) as typeof fetch;

		try {
			const request = new Request(ENDPOINT, {
				method: "POST",
				headers: { ...VALID_HEADERS, "Content-Type": "application/json" },
				body: VALID_BODY,
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.headers.get("Content-Type")).toBe("application/json");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not forward Authorization header to LiteLLM", async () => {
		let capturedHeaders: Record<string, string> | null = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
			capturedHeaders = (init?.headers as Record<string, string>) ?? null;
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const request = new Request(ENDPOINT, {
				method: "POST",
				headers: { ...VALID_HEADERS, "Content-Type": "application/json" },
				body: VALID_BODY,
			});
			const ctx = createExecutionContext();
			await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(capturedHeaders?.["Authorization"]).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
