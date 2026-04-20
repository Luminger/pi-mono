/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel, ToolExecutionMode } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import type { SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { SourceInfo } from "../../core/source-info.js";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// Tool hooks
	| {
			id?: string;
			type: "subscribe_tool_hooks";
			hooks: { tool_call?: boolean; tool_result?: boolean };
			toolNames?: string[];
	  }
	| { id?: string; type: "unsubscribe_tool_hooks" }

	// Client-implemented tools
	| { id?: string; type: "register_tool"; tool: RpcToolRegistration }
	| { id?: string; type: "unregister_tool"; toolName: string };

// ============================================================================
// Client-Implemented Tools
// ============================================================================

/**
 * Description of a tool whose execution logic lives in the RPC client process.
 * The server creates a bridge tool that forwards execution requests over the
 * protocol. Parameters are JSON Schema, wrapped into TypeBox via `Type.Unsafe`
 * on the server for validation.
 */
export interface RpcToolRegistration {
	name: string;
	label: string;
	description: string;
	/** JSON Schema for the tool's parameter object. */
	parameters: Record<string, unknown>;
	promptSnippet?: string;
	promptGuidelines?: string[];
	executionMode?: ToolExecutionMode;
}

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Tool hooks
	| { id?: string; type: "response"; command: "subscribe_tool_hooks"; success: true }
	| { id?: string; type: "response"; command: "unsubscribe_tool_hooks"; success: true }

	// Client-implemented tools
	| { id?: string; type: "response"; command: "register_tool"; success: true }
	| { id?: string; type: "response"; command: "unregister_tool"; success: true }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Tool Hook Events (stdout)
// ============================================================================

/** Emitted before a tool executes, asking the client to evaluate the call */
export interface RpcToolCallHookRequest {
	type: "tool_call_hook_request";
	id: string;
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

/** Emitted after a tool executes, asking the client to evaluate the result */
export interface RpcToolResultHookRequest {
	type: "tool_result_hook_request";
	id: string;
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

export type RpcToolHookRequest = RpcToolCallHookRequest | RpcToolResultHookRequest;

// ============================================================================
// Tool Hook Commands (stdin)
// ============================================================================

/** Response to a tool_call_hook_request */
export interface RpcToolCallHookResponse {
	type: "tool_call_hook_response";
	id: string;
	block?: boolean;
	reason?: string;
	args?: Record<string, unknown>;
}

/** Response to a tool_result_hook_request */
export interface RpcToolResultHookResponse {
	type: "tool_result_hook_response";
	id: string;
	content?: (TextContent | ImageContent)[];
	isError?: boolean;
}

export type RpcToolHookResponse = RpcToolCallHookResponse | RpcToolResultHookResponse;

// ============================================================================
// Client Tool Execution Events (stdout)
// ============================================================================

/** Server asks the client to execute a registered tool. */
export interface RpcToolExecuteRequest {
	type: "tool_execute_request";
	id: string;
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

/** Server tells the client a pending execution was cancelled (agent aborted). */
export interface RpcToolExecuteCancel {
	type: "tool_execute_cancel";
	id: string;
}

// ============================================================================
// Client Tool Execution Responses (stdin)
// ============================================================================

/** Optional streaming partial update from the client during tool execution. */
export interface RpcToolExecuteUpdate {
	type: "tool_execute_update";
	id: string;
	content: (TextContent | ImageContent)[];
}

/** Final result from client tool execution. */
export interface RpcToolExecuteResponse {
	type: "tool_execute_response";
	id: string;
	content: (TextContent | ImageContent)[];
	isError?: boolean;
}

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
