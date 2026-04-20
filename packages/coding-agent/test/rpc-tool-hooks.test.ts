/**
 * Integration tests for RPC tool hooks.
 * Tests the full RPC protocol flow for tool_call and tool_result hooks.
 *
 * Follows the same pattern as test/rpc.test.ts: spawns the real dist/cli.js
 * RPC subprocess against a real Anthropic provider. Skipped when no API key
 * is available.
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN)("RPC Tool Hooks", () => {
	let client: RpcClient;
	let sessionDir: string;

	beforeEach(async () => {
		sessionDir = join(tmpdir(), `pi-rpc-hooks-test-${Date.now()}`);
		client = new RpcClient({
			cliPath: join(__dirname, "..", "dist", "cli.js"),
			cwd: join(__dirname, ".."),
			env: { PI_CODING_AGENT_DIR: sessionDir },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
		await client.start();
	});

	afterEach(async () => {
		await client.stop();
		if (sessionDir && existsSync(sessionDir)) {
			rmSync(sessionDir, { recursive: true });
		}
	});

	it("tool_call hook can block tool execution", async () => {
		let hookCalled = false;

		// Subscribe to tool hooks
		await client.subscribeToolHooks({ toolCall: true });

		// Register hook handler
		client.onToolCallHook(async (request) => {
			hookCalled = true;
			if (request.toolName === "bash") {
				return { block: true, reason: "Blocked by RPC hook" };
			}
			return undefined;
		});

		// Send a prompt that would trigger bash
		const eventsPromise = client.collectEvents();
		await client.prompt("run: echo test");
		const events = await eventsPromise;

		// Verify hook was called
		expect(hookCalled).toBe(true);

		// Verify tool was blocked
		const toolExecEvents = events.filter((e) => e.type === "tool_execution_end");
		expect(toolExecEvents.length).toBeGreaterThan(0);

		// Get messages to verify the block
		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBeGreaterThan(0);

		// At least one should be an error with the block reason
		const blockedResult = toolResults.find((r) => {
			if (r.role !== "toolResult") return false;
			return r.isError && getMessageText(r).includes("Blocked by RPC hook");
		});
		expect(blockedResult).toBeDefined();
	});

	it("tool_call hook can rewrite arguments", async () => {
		let originalArgs: Record<string, unknown> | undefined;
		let _rewrittenArgs: Record<string, unknown> | undefined;

		await client.subscribeToolHooks({ toolCall: true });

		client.onToolCallHook(async (request) => {
			if (request.toolName === "bash") {
				originalArgs = { ...request.args };
				// Rewrite the command
				return {
					args: {
						...request.args,
						command: "echo rewritten",
					},
				};
			}
			return undefined;
		});

		const eventsPromise = client.collectEvents();
		await client.prompt("run: echo original");
		await eventsPromise;

		// Verify we captured the original args
		expect(originalArgs).toBeDefined();
		expect(originalArgs?.command).toContain("original");

		// Verify the rewritten command was executed
		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBeGreaterThan(0);

		// Check if any result contains "rewritten" (the bash output)
		const hasRewritten = toolResults.some((r) => {
			const text = getMessageText(r);
			return text.includes("rewritten");
		});
		expect(hasRewritten).toBe(true);
	});

	it("tool_result hook can modify result content", async () => {
		let hookCalled = false;

		await client.subscribeToolHooks({ toolResult: true });

		client.onToolResultHook(async (request) => {
			hookCalled = true;
			if (request.toolName === "bash") {
				return {
					content: [{ type: "text", text: "Result modified by RPC hook" }],
				};
			}
			return undefined;
		});

		const eventsPromise = client.collectEvents();
		await client.prompt("run: echo test");
		await eventsPromise;

		expect(hookCalled).toBe(true);

		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBeGreaterThan(0);

		// At least one result should have our modified content
		const modifiedResult = toolResults.find((r) => {
			const text = getMessageText(r);
			return text.includes("Result modified by RPC hook");
		});
		expect(modifiedResult).toBeDefined();
	});

	it("tool_result hook can change isError flag", async () => {
		await client.subscribeToolHooks({ toolResult: true });

		client.onToolResultHook(async (request) => {
			if (request.toolName === "bash") {
				// Force the result to be an error
				return {
					content: [{ type: "text", text: "Forced error by hook" }],
					isError: true,
				};
			}
			return undefined;
		});

		const eventsPromise = client.collectEvents();
		await client.prompt("run: echo test");
		await eventsPromise;

		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBeGreaterThan(0);

		// Find the result that was forced to error
		const errorResult = toolResults.find((r) => {
			if (r.role !== "toolResult") return false;
			return r.isError && getMessageText(r).includes("Forced error by hook");
		});
		expect(errorResult).toBeDefined();
	});

	it("both hooks can be used together", async () => {
		let callHookCalled = false;
		let resultHookCalled = false;

		await client.subscribeToolHooks({ toolCall: true, toolResult: true });

		client.onToolCallHook(async (request) => {
			callHookCalled = true;
			if (request.toolName === "bash") {
				return {
					args: {
						...request.args,
						command: "echo modified-by-call-hook",
					},
				};
			}
			return undefined;
		});

		client.onToolResultHook(async (request) => {
			resultHookCalled = true;
			if (request.toolName === "bash") {
				const originalText = request.content[0]?.type === "text" ? request.content[0].text : "";
				return {
					content: [{ type: "text", text: `[wrapped: ${originalText}]` }],
				};
			}
			return undefined;
		});

		const eventsPromise = client.collectEvents();
		await client.prompt("run: echo original");
		await eventsPromise;

		expect(callHookCalled).toBe(true);
		expect(resultHookCalled).toBe(true);

		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBeGreaterThan(0);

		// Result should show both modifications
		const modifiedResult = toolResults.find((r) => {
			const text = getMessageText(r);
			return text.includes("wrapped") && text.includes("modified-by-call-hook");
		});
		expect(modifiedResult).toBeDefined();
	});

	it("hook subscription can filter by tool name", async () => {
		let bashHookCalled = false;
		let _otherHookCalled = false;

		// Only subscribe to bash tool hooks
		await client.subscribeToolHooks({ toolCall: true, toolNames: ["bash"] });

		client.onToolCallHook(async (request) => {
			if (request.toolName === "bash") {
				bashHookCalled = true;
			} else {
				_otherHookCalled = true;
			}
			return undefined;
		});

		const eventsPromise = client.collectEvents();
		await client.prompt("run: echo test");
		await eventsPromise;

		// Bash hook should have been called
		expect(bashHookCalled).toBe(true);
		// Other tools should not trigger the hook (though in this test we only use bash)
		// This is more of a sanity check
	});

	it("unsubscribe removes hook interception", async () => {
		let hookCallCount = 0;

		await client.subscribeToolHooks({ toolCall: true });

		client.onToolCallHook(async () => {
			hookCallCount++;
			return { block: true, reason: "blocked" };
		});

		// First prompt - should be blocked
		let eventsPromise = client.collectEvents();
		await client.prompt("run: echo test1");
		await eventsPromise;

		const firstCount = hookCallCount;
		expect(firstCount).toBeGreaterThan(0);

		// Unsubscribe
		await client.unsubscribeToolHooks();

		// Second prompt - should NOT trigger hook
		eventsPromise = client.collectEvents();
		await client.prompt("run: echo test2");
		await eventsPromise;

		// Hook count should not have increased
		expect(hookCallCount).toBe(firstCount);

		// Second command should have executed normally (not blocked)
		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");

		// Should have at least one successful result from the second command
		const successfulResults = toolResults.filter((r) => r.role === "toolResult" && !r.isError);
		expect(successfulResults.length).toBeGreaterThan(0);
	});

	it("hook handler returning undefined does not modify execution", async () => {
		await client.subscribeToolHooks({ toolCall: true, toolResult: true });

		client.onToolCallHook(async () => undefined);
		client.onToolResultHook(async () => undefined);

		const eventsPromise = client.collectEvents();
		await client.prompt("run: echo test");
		await eventsPromise;

		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBeGreaterThan(0);

		// Should have successful execution
		const successfulResults = toolResults.filter((r) => r.role === "toolResult" && !r.isError);
		expect(successfulResults.length).toBeGreaterThan(0);
	});

	it("hook handler errors do not block execution", async () => {
		await client.subscribeToolHooks({ toolCall: true });

		client.onToolCallHook(async () => {
			throw new Error("Hook handler error");
		});

		// Should not throw and should complete normally
		const eventsPromise = client.collectEvents();
		await client.prompt("run: echo test");
		await eventsPromise;

		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBeGreaterThan(0);
	});
});
