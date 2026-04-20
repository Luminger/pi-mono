import type { AgentTool } from "@mariozechner/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.js";

describe("AgentSession external tool hooks", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function createEchoTool(): { tool: AgentTool; runs: string[] } {
		const runs: string[] = [];
		const tool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				runs.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		return { tool, runs };
	}

	// =========================================================================
	// tool_call hooks (pre-execution)
	// =========================================================================

	it("onToolCall hook can block tool execution", async () => {
		const { tool, runs } = createEchoTool();
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		harness.session.setExternalToolHooks({
			onToolCall: async (event) => {
				if (event.toolName === "echo") {
					return { block: true, reason: "Blocked by external hook" };
				}
				return undefined;
			},
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done after block"),
		]);

		await harness.session.prompt("start");

		// Tool should not have executed
		expect(runs).toEqual([]);

		// Should have a tool result with the block reason
		const toolResult = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		expect(getMessageText(toolResult!)).toContain("Blocked by external hook");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
		}
	});

	it("onToolCall hook can rewrite arguments via mutation", async () => {
		const { tool, runs } = createEchoTool();
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		harness.session.setExternalToolHooks({
			onToolCall: async (event) => {
				if (event.toolName === "echo") {
					// Mutate args in place (same semantics as extension tool_call handlers)
					event.args.text = "rewritten";
				}
				return undefined;
			},
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "original" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		// Tool should have received the rewritten args
		expect(runs).toEqual(["rewritten"]);
	});

	it("onToolCall hook returning undefined does not affect execution", async () => {
		const { tool, runs } = createEchoTool();
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		harness.session.setExternalToolHooks({
			onToolCall: async () => undefined,
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(runs).toEqual(["hello"]);
	});

	// =========================================================================
	// tool_result hooks (post-execution)
	// =========================================================================

	it("onToolResult hook can modify tool result content", async () => {
		const { tool } = createEchoTool();
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		harness.session.setExternalToolHooks({
			onToolResult: async (event) => {
				if (event.toolName === "echo") {
					return {
						content: [{ type: "text", text: "modified result" }],
					};
				}
				return undefined;
			},
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		const toolResult = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		expect(getMessageText(toolResult!)).toBe("modified result");
	});

	it("onToolResult hook can change isError flag", async () => {
		const { tool } = createEchoTool();
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		harness.session.setExternalToolHooks({
			onToolResult: async (event) => {
				if (event.toolName === "echo") {
					return {
						content: [{ type: "text", text: "forced error" }],
						isError: true,
					};
				}
				return undefined;
			},
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		const toolResult = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
		}
		expect(getMessageText(toolResult!)).toBe("forced error");
	});

	it("onToolResult hook returning undefined does not affect result", async () => {
		const { tool } = createEchoTool();
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		harness.session.setExternalToolHooks({
			onToolResult: async () => undefined,
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		const toolResult = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		expect(getMessageText(toolResult!)).toBe("echo:hello");
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(false);
		}
	});

	// =========================================================================
	// Combined hooks
	// =========================================================================

	it("both onToolCall and onToolResult hooks compose correctly", async () => {
		const { tool, runs } = createEchoTool();
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		harness.session.setExternalToolHooks({
			onToolCall: async (event) => {
				if (event.toolName === "echo") {
					event.args.text = "hook-rewritten";
				}
				return undefined;
			},
			onToolResult: async (event) => {
				if (event.toolName === "echo") {
					return {
						content: [
							{
								type: "text",
								text: `result-modified(${event.content[0]?.type === "text" ? event.content[0].text : ""})`,
							},
						],
					};
				}
				return undefined;
			},
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "original" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		// Tool received rewritten args
		expect(runs).toEqual(["hook-rewritten"]);

		// Result was modified by the result hook
		const toolResult = harness.session.messages.find((m) => m.role === "toolResult");
		expect(getMessageText(toolResult!)).toBe("result-modified(echo:hook-rewritten)");
	});

	// =========================================================================
	// Hook lifecycle
	// =========================================================================

	it("clearing hooks removes interception", async () => {
		const { tool, runs } = createEchoTool();
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);

		harness.session.setExternalToolHooks({
			onToolCall: async () => ({ block: true, reason: "blocked" }),
		});

		// First prompt: blocked
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "a" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("blocked response"),
		]);
		await harness.session.prompt("first");
		expect(runs).toEqual([]);

		// Clear hooks
		harness.session.setExternalToolHooks({});

		// Second prompt: should execute normally
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "b" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("normal response"),
		]);
		await harness.session.prompt("second");
		expect(runs).toEqual(["b"]);
	});
});
