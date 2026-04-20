/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type {
	ExtensionContext,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	ToolDefinition,
} from "../../core/extensions/index.js";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	RpcToolCallHookRequest,
	RpcToolCallHookResponse,
	RpcToolExecuteCancel,
	RpcToolExecuteRequest,
	RpcToolExecuteResponse,
	RpcToolExecuteUpdate,
	RpcToolRegistration,
	RpcToolResultHookRequest,
	RpcToolResultHookResponse,
} from "./rpc-types.js";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcToolCallHookRequest,
	RpcToolCallHookResponse,
	RpcToolExecuteCancel,
	RpcToolExecuteRequest,
	RpcToolExecuteResponse,
	RpcToolExecuteUpdate,
	RpcToolHookRequest,
	RpcToolRegistration,
	RpcToolResultHookRequest,
	RpcToolResultHookResponse,
} from "./rpc-types.js";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	// Tool hook state
	let toolHookSubscription: {
		toolCall: boolean;
		toolResult: boolean;
		toolNames: Set<string> | null; // null = all tools
	} | null = null;

	const pendingToolHooks = new Map<string, { resolve: (result: unknown) => void }>();

	// Client-implemented tool state
	const clientTools = new Map<string, RpcToolRegistration>();
	const pendingToolExecutions = new Map<
		string,
		{
			resolve: (result: { content: (TextContent | ImageContent)[]; isError: boolean }) => void;
			reject: (error: Error) => void;
			onUpdate: (update: { content: (TextContent | ImageContent)[] }) => void;
		}
	>();

	/**
	 * Build a ToolDefinition that forwards execution to the RPC client.
	 * The agent core validates args against `parameters` before `execute` runs,
	 * so the client always sees schema-valid input.
	 */
	const createRpcBridgeTool = (reg: RpcToolRegistration): ToolDefinition => ({
		name: reg.name,
		label: reg.label,
		description: reg.description,
		parameters: Type.Unsafe(reg.parameters),
		promptSnippet: reg.promptSnippet,
		promptGuidelines: reg.promptGuidelines,
		executionMode: reg.executionMode,
		// ExtensionContext is accepted and ignored; client tools don't receive
		// server-side context. Clients can query server state via existing RPC
		// commands (e.g. get_state) if needed.
		execute: (toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) => {
			const requestId = crypto.randomUUID();

			return new Promise((resolve, reject) => {
				const cleanup = () => {
					pendingToolExecutions.delete(requestId);
					signal?.removeEventListener("abort", onAbort);
				};

				const onAbort = () => {
					cleanup();
					output({ type: "tool_execute_cancel", id: requestId } satisfies RpcToolExecuteCancel);
					reject(new Error("Tool execution aborted"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				pendingToolExecutions.set(requestId, {
					resolve: (response) => {
						cleanup();
						if (response.isError) {
							const errorText =
								response.content
									.filter((c): c is TextContent => c.type === "text")
									.map((c) => c.text)
									.join("\n") || "Tool execution failed";
							reject(new Error(errorText));
						} else {
							resolve({ content: response.content, details: undefined });
						}
					},
					reject: (err) => {
						cleanup();
						reject(err);
					},
					onUpdate: (update) => {
						onUpdate?.({ content: update.content, details: undefined });
					},
				});

				output({
					type: "tool_execute_request",
					id: requestId,
					toolCallId,
					toolName: reg.name,
					args: params as Record<string, unknown>,
				} satisfies RpcToolExecuteRequest);
			});
		},
	});

	/**
	 * Re-install all client bridge tools on the current session. Called when a
	 * session is rebound (new/switch/fork) so registered client tools survive
	 * across session changes for the lifetime of the RPC process.
	 */
	const reinstallClientTools = (): void => {
		for (const reg of clientTools.values()) {
			session.addCustomTool(createRpcBridgeTool(reg));
		}
	};

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	/**
	 * Install external tool hooks on the session based on current subscription.
	 * Called when subscription changes or session is rebound.
	 */
	const installRpcToolHooks = (): void => {
		if (!toolHookSubscription) {
			session.setExternalToolHooks({});
			return;
		}

		session.setExternalToolHooks({
			onToolCall: async (event) => {
				if (!toolHookSubscription?.toolCall) return undefined;
				if (toolHookSubscription.toolNames && !toolHookSubscription.toolNames.has(event.toolName)) {
					return undefined;
				}

				const hookId = crypto.randomUUID();
				return new Promise((resolve) => {
					const signal = session.agent.signal;
					const onAbort = () => {
						pendingToolHooks.delete(hookId);
						resolve(undefined);
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					pendingToolHooks.set(hookId, {
						resolve: (raw: unknown) => {
							signal?.removeEventListener("abort", onAbort);
							pendingToolHooks.delete(hookId);
							const response = raw as RpcToolCallHookResponse | undefined;
							if (!response || (!response.block && !response.args)) {
								resolve(undefined);
								return;
							}
							if (response.args) {
								for (const key of Object.keys(event.args)) delete event.args[key];
								Object.assign(event.args, response.args);
							}
							resolve(response.block ? { block: true, reason: response.reason } : undefined);
						},
					});

					output({
						type: "tool_call_hook_request",
						id: hookId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					} satisfies RpcToolCallHookRequest);
				});
			},

			onToolResult: async (event) => {
				if (!toolHookSubscription?.toolResult) return undefined;
				if (toolHookSubscription.toolNames && !toolHookSubscription.toolNames.has(event.toolName)) {
					return undefined;
				}

				const hookId = crypto.randomUUID();
				return new Promise((resolve) => {
					const signal = session.agent.signal;
					const onAbort = () => {
						pendingToolHooks.delete(hookId);
						resolve(undefined);
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					pendingToolHooks.set(hookId, {
						resolve: (raw: unknown) => {
							signal?.removeEventListener("abort", onAbort);
							pendingToolHooks.delete(hookId);
							const response = raw as RpcToolResultHookResponse | undefined;
							if (!response || (response.content === undefined && response.isError === undefined)) {
								resolve(undefined);
								return;
							}
							resolve({ content: response.content, isError: response.isError });
						},
					});

					output({
						type: "tool_result_hook_request",
						id: hookId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						content: event.content,
						isError: event.isError,
					} satisfies RpcToolResultHookRequest);
				});
			},
		});
	};

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (options) => {
					const result = await runtimeHost.newSession(options);
					if (!result.cancelled) {
						await rebindSession();
					}
					return result;
				},
				fork: async (entryId) => {
					const result = await runtimeHost.fork(entryId);
					if (!result.cancelled) {
						await rebindSession();
					}
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath) => {
					const result = await runtimeHost.switchSession(sessionPath);
					if (!result.cancelled) {
						await rebindSession();
					}
					return result;
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			output(event);
		});

		// Re-install tool hooks on the new session if subscription is active
		if (toolHookSubscription) {
			installRpcToolHooks();
		}

		// Re-install client-registered tools on the new session
		if (clientTools.size > 0) {
			reinstallClientTools();
		}
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner?.getRegisteredCommands() ?? []) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			// =================================================================
			// Tool Hooks
			// =================================================================

			case "subscribe_tool_hooks": {
				toolHookSubscription = {
					toolCall: command.hooks.tool_call ?? false,
					toolResult: command.hooks.tool_result ?? false,
					toolNames: command.toolNames ? new Set(command.toolNames) : null,
				};
				installRpcToolHooks();
				return success(id, "subscribe_tool_hooks");
			}

			case "unsubscribe_tool_hooks": {
				toolHookSubscription = null;
				session.setExternalToolHooks({});
				return success(id, "unsubscribe_tool_hooks");
			}

			// =================================================================
			// Client-Implemented Tools
			// =================================================================

			case "register_tool": {
				if (session.isStreaming) {
					return error(id, "register_tool", "Cannot register tools while agent is streaming");
				}
				const reg = command.tool;
				if (!reg || typeof reg.name !== "string" || !reg.name) {
					return error(id, "register_tool", "register_tool requires a tool with a non-empty name");
				}
				clientTools.set(reg.name, reg);
				session.addCustomTool(createRpcBridgeTool(reg));
				return success(id, "register_tool");
			}

			case "unregister_tool": {
				if (session.isStreaming) {
					return error(id, "unregister_tool", "Cannot unregister tools while agent is streaming");
				}
				if (!clientTools.has(command.toolName)) {
					return error(id, "unregister_tool", `No client tool registered: ${command.toolName}`);
				}
				clientTools.delete(command.toolName);
				session.removeCustomTool(command.toolName);
				return success(id, "unregister_tool");
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		unsubscribe?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		// Handle tool hook responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			(parsed.type === "tool_call_hook_response" || parsed.type === "tool_result_hook_response")
		) {
			const response = parsed as RpcToolCallHookResponse | RpcToolResultHookResponse;
			const pending = pendingToolHooks.get(response.id);
			if (pending) {
				pending.resolve(response);
			}
			return;
		}

		// Handle client tool execution streaming updates
		if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "tool_execute_update") {
			const update = parsed as RpcToolExecuteUpdate;
			const pending = pendingToolExecutions.get(update.id);
			if (pending) {
				pending.onUpdate({ content: update.content });
			}
			return;
		}

		// Handle client tool execution final responses
		if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "tool_execute_response") {
			const response = parsed as RpcToolExecuteResponse;
			const pending = pendingToolExecutions.get(response.id);
			if (pending) {
				pending.resolve({ content: response.content, isError: response.isError ?? false });
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
		}
	};

	const onInputEnd = () => {
		// Reject any in-flight client tool executions so the agent loop doesn't
		// hang waiting for responses that will never arrive after the client
		// disconnected. Pending tool-hook resolutions are left to resolve with
		// `undefined` via the agent signal abort that fires during shutdown.
		for (const [, pending] of pendingToolExecutions) {
			pending.reject(new Error("RPC client disconnected before tool execution completed"));
		}
		pendingToolExecutions.clear();
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
