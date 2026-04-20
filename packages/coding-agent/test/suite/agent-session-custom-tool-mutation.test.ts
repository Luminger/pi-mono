import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/extensions/index.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

/**
 * Covers AgentSession.addCustomTool / removeCustomTool -- the public surface
 * RPC mode uses to expose client-implemented tools as first-class agent tools
 * after construction.
 */
describe("AgentSession custom tool mutation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function makeEchoToolDefinition(suffix = ""): { tool: ToolDefinition; runs: string[] } {
		const runs: string[] = [];
		const tool: ToolDefinition = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				runs.push(text);
				return {
					content: [{ type: "text", text: `echo${suffix}:${text}` }],
					details: { text },
				};
			},
		};
		return { tool, runs };
	}

	it("addCustomTool lets the agent invoke a tool registered after construction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const { tool, runs } = makeEchoToolDefinition();
		harness.session.addCustomTool(tool);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(runs).toEqual(["hello"]);

		const toolResult = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		expect(getMessageText(toolResult!)).toContain("echo:hello");
	});

	it("addCustomTool called twice with the same name replaces the previous registration", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const first = makeEchoToolDefinition("-v1");
		const second = makeEchoToolDefinition("-v2");

		harness.session.addCustomTool(first.tool);
		harness.session.addCustomTool(second.tool);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		// Only the second registration should have executed.
		expect(first.runs).toEqual([]);
		expect(second.runs).toEqual(["hi"]);
	});

	it("removeCustomTool unregisters the tool so subsequent calls report it as unknown", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const { tool, runs } = makeEchoToolDefinition();
		harness.session.addCustomTool(tool);
		harness.session.removeCustomTool("echo");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		// The removed tool must not have executed.
		expect(runs).toEqual([]);

		// Agent loop reports unknown-tool errors as tool results.
		const toolResult = harness.session.messages.find((m) => m.role === "toolResult");
		expect(toolResult).toBeDefined();
		if (toolResult?.role === "toolResult") {
			expect(toolResult.isError).toBe(true);
		}
	});

	it("removeCustomTool is a no-op for unknown names", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Must not throw. Idempotent on a session that never registered the tool.
		expect(() => harness.session.removeCustomTool("never-registered")).not.toThrow();
	});

	it("custom tool participates in external tool hooks like any other tool", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const { tool, runs } = makeEchoToolDefinition();
		harness.session.addCustomTool(tool);

		let hookSawArgs: Record<string, unknown> | undefined;
		harness.session.setExternalToolHooks({
			onToolCall: async (event) => {
				if (event.toolName === "echo") {
					hookSawArgs = { ...event.args };
					event.args.text = "rewritten-by-hook";
				}
				return undefined;
			},
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "original" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(hookSawArgs).toEqual({ text: "original" });
		// Hook rewrote args in place; the tool must see the rewritten value.
		expect(runs).toEqual(["rewritten-by-hook"]);
	});
});
