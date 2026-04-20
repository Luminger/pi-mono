/**
 * Integration tests for RPC client-implemented tools.
 *
 * Follows the same pattern as test/rpc.test.ts and test/rpc-tool-hooks.test.ts:
 * spawns the real dist/cli.js RPC subprocess against a real Anthropic provider.
 * Skipped when no API key is available.
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN)("RPC Client Tools", () => {
	let client: RpcClient;
	let sessionDir: string;

	beforeEach(async () => {
		sessionDir = join(tmpdir(), `pi-rpc-client-tools-test-${Date.now()}`);
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

	it("client-registered tool is invoked by the agent and receives validated args", async () => {
		let sawArgs: Record<string, unknown> | undefined;

		client.onToolExecute(async (request) => {
			if (request.toolName === "random_number") {
				sawArgs = { ...request.args };
				return {
					content: [{ type: "text", text: "42" }],
				};
			}
			return { content: [{ type: "text", text: "unknown tool" }], isError: true };
		});

		await client.registerTool({
			name: "random_number",
			label: "Random Number",
			description:
				"Returns a random integer between min and max. Use this whenever the user asks for a random number.",
			parameters: {
				type: "object",
				properties: {
					min: { type: "number" },
					max: { type: "number" },
				},
				required: ["min", "max"],
			},
		});

		const eventsPromise = client.collectEvents();
		await client.prompt("Call the random_number tool with min=1 and max=100. Just call it, no other output.");
		await eventsPromise;

		expect(sawArgs).toBeDefined();
		expect(sawArgs).toHaveProperty("min");
		expect(sawArgs).toHaveProperty("max");

		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		const ours = toolResults.find((r) => getMessageText(r).includes("42"));
		expect(ours).toBeDefined();
	});

	it("handler errors surface as isError tool results without crashing the agent", async () => {
		client.onToolExecute(async () => {
			throw new Error("boom");
		});

		await client.registerTool({
			name: "failing_tool",
			label: "Failing",
			description: "Always throws. Use this when the user says 'please fail'.",
			parameters: { type: "object", properties: {}, required: [] },
		});

		const eventsPromise = client.collectEvents();
		await client.prompt("Please fail. Call failing_tool once.");
		await eventsPromise;

		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		const errResult = toolResults.find(
			(r) => r.role === "toolResult" && r.isError && getMessageText(r).includes("boom"),
		);
		expect(errResult).toBeDefined();
	});

	it("unregisterTool restores the prior state so the agent can no longer invoke the tool", async () => {
		let callCount = 0;
		client.onToolExecute(async () => {
			callCount++;
			return { content: [{ type: "text", text: "ok" }] };
		});

		await client.registerTool({
			name: "marker_tool",
			label: "Marker",
			description: "A marker tool. Call this when the user says 'mark'.",
			parameters: { type: "object", properties: {}, required: [] },
		});

		const firstRun = client.collectEvents();
		await client.prompt("mark. Call marker_tool once.");
		await firstRun;

		const afterFirst = callCount;
		expect(afterFirst).toBeGreaterThan(0);

		await client.unregisterTool("marker_tool");

		const secondRun = client.collectEvents();
		await client.prompt(
			"Try to call marker_tool again. If it isn't available, just say so in plain text. Do not call anything else.",
		);
		await secondRun;

		// The handler must not have been invoked after unregistration.
		expect(callCount).toBe(afterFirst);
	});

	it("registering a tool with the same name as a builtin shadows the builtin", async () => {
		let shadowed = false;
		client.onToolExecute(async (request) => {
			if (request.toolName === "bash") {
				shadowed = true;
				return { content: [{ type: "text", text: "shadowed bash output" }] };
			}
			return { content: [{ type: "text", text: "" }], isError: true };
		});

		await client.registerTool({
			name: "bash",
			label: "Bash (shadowed)",
			description: "Shadow of bash. Use this instead of the builtin whenever bash is requested.",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			},
		});

		const eventsPromise = client.collectEvents();
		await client.prompt("Run bash with the command `echo hi`. Just run it once.");
		await eventsPromise;

		expect(shadowed).toBe(true);

		const messages = await client.getMessages();
		const toolResults = messages.filter((m) => m.role === "toolResult");
		const ours = toolResults.find((r) => getMessageText(r).includes("shadowed bash output"));
		expect(ours).toBeDefined();
	});

	it("rejects register_tool while the agent is streaming", async () => {
		// Kick off a streaming prompt but don't await it fully -- let it race.
		const streamingDone = client.collectEvents();
		await client.prompt("Count slowly from 1 to 5, one number per line.");

		// Small delay to ensure the agent is in streaming state.
		await new Promise((resolve) => setTimeout(resolve, 500));

		await expect(
			client.registerTool({
				name: "mid_stream_tool",
				label: "Mid",
				description: "-",
				parameters: { type: "object", properties: {}, required: [] },
			}),
		).rejects.toThrow(/streaming/i);

		await streamingDone;
	});
});
