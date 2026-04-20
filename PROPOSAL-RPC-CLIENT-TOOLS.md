# Proposal: Client-Implemented Tools over RPC

## Goal

Allow RPC clients to register tools whose execution logic lives in the client process. When the LLM calls such a tool, the server sends an execution request over the RPC protocol, the client runs the logic, and sends back the result. The tool is a first-class participant in the server's tool machinery: system prompt injection, hooks, agent events, shadowing of builtins by name.

This proposal assumes the RPC tool event hooks proposal is already implemented. Client tools participate in the hook system like any other tool.

## How It Plugs In

Client-registered tools are injected via `AgentSession._customTools`. Today this list is set once at construction. We add public mutation methods:

```typescript
// AgentSession
addCustomTool(tool: ToolDefinition): void {
  this._customTools = this._customTools.filter(t => t.name !== tool.name);
  this._customTools.push(tool);
  this._refreshToolRegistry();
}

removeCustomTool(name: string): void {
  const before = this._customTools.length;
  this._customTools = this._customTools.filter(t => t.name !== name);
  if (this._customTools.length !== before) {
    this._refreshToolRegistry();
  }
}
```

Because the tool is a standard `ToolDefinition`, it gets:

- **Shadowing**: `_refreshToolRegistry` iterates custom tools after builtins. A client tool named `"bash"` replaces the builtin in both `_toolDefinitions` and `_toolRegistry`.
- **Extension hooks fire**: `beforeToolCall`/`afterToolCall` in the agent loop run around every `execute()`. Extension `tool_call`/`tool_result` handlers fire for client tools identically to builtins.
- **RPC hooks fire**: If the RPC client has subscribed to hooks, its own client-registered tools are also subject to those hooks. This is consistent — a client might register a tool and separately have a permission gate that applies to all tools.
- **Agent events fire**: `tool_execution_start/update/end` are emitted by the agent loop. These flow to the RPC subscriber via `_emit()`. The client sees the full event stream for its own tools.
- **System prompt**: `promptSnippet` and `promptGuidelines` are picked up by `_refreshToolRegistry` and injected into the system prompt.

## Execution Order for a Client Tool

```
1. tool_execution_start          (agent event -> RPC client, notification)
2. extension tool_call handlers  (server-side, may mutate args or block)
3. tool_call_hook_request        (RPC hook proposal, if subscribed)
4. tool_execute_request          (this proposal -- RPC client runs the tool)
5. tool_execute_update*          (this proposal -- optional streaming updates from client)
6. tool_execute_response         (this proposal -- RPC client returns result)
7. extension tool_result handlers(server-side, may modify result)
8. tool_result_hook_request      (RPC hook proposal, if subscribed)
9. tool_execution_end            (agent event -> RPC client, notification)
```

Steps 2-3 happen inside `beforeToolCall`. Steps 7-8 happen inside `afterToolCall`. Steps 4-6 happen inside `tool.execute()`. The agent loop orchestrates all of this -- no special casing for client tools.

## Protocol Additions

### New Commands (client -> server, stdin)

```typescript
// Register a client-implemented tool (or shadow an existing one by name)
| {
    id?: string;
    type: "register_tool";
    tool: {
      name: string;
      label: string;
      description: string;
      parameters: JSONSchema;
      promptSnippet?: string;
      promptGuidelines?: string[];
    };
  }

// Remove a client tool. If it shadowed a builtin, the builtin is restored.
| { id?: string; type: "unregister_tool"; toolName: string }

// Final result from client tool execution
| {
    type: "tool_execute_response";
    id: string;
    content: (TextContent | ImageContent)[];
    isError?: boolean;
  }

// Streaming partial update during client tool execution (optional)
| {
    type: "tool_execute_update";
    id: string;
    content: (TextContent | ImageContent)[];
  }
```

### New Events (server -> client, stdout)

```typescript
// Server asks client to execute a registered tool
| {
    type: "tool_execute_request";
    id: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }

// Server tells client a pending execution was cancelled (agent aborted)
| {
    type: "tool_execute_cancel";
    id: string;
  }
```

### New Responses (server -> client, stdout)

```typescript
| { id?: string; type: "response"; command: "register_tool"; success: true }
| { id?: string; type: "response"; command: "unregister_tool"; success: true }
```

## JSON Schema Handling

Parameters use JSON Schema (language-agnostic) rather than TypeBox. The server wraps on registration:

```typescript
import { Type } from "@sinclair/typebox";
const tbSchema = Type.Unsafe(registration.parameters);
```

TypeBox's `Value.Check()` works against any valid JSON Schema, so validation is identical.

## Server-Side Implementation (rpc-mode.ts)

### State

```typescript
const clientTools = new Map<string, RpcToolRegistration>();
const pendingToolExecutions = new Map<string, {
  resolve: (result: { content: (TextContent | ImageContent)[]; isError: boolean }) => void;
  reject: (error: Error) => void;
  onUpdate: (update: { content: (TextContent | ImageContent)[] }) => void;
}>();
```

### Bridge Tool Factory

```typescript
function createRpcBridgeTool(
  reg: RpcToolRegistration,
  output: OutputFn,
  pending: typeof pendingToolExecutions,
): ToolDefinition {
  return {
    name: reg.name,
    label: reg.label,
    description: reg.description,
    parameters: Type.Unsafe(reg.parameters),
    promptSnippet: reg.promptSnippet,
    promptGuidelines: reg.promptGuidelines,

    execute(toolCallId, params, signal, onUpdate) {
      const requestId = crypto.randomUUID();

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          pending.delete(requestId);
          signal?.removeEventListener("abort", onAbort);
        };

        const onAbort = () => {
          cleanup();
          output({ type: "tool_execute_cancel", id: requestId });
          reject(new Error("Tool execution aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        pending.set(requestId, {
          resolve: (response) => {
            cleanup();
            if (response.isError) {
              const errorText = response.content
                .filter((c): c is TextContent => c.type === "text")
                .map(c => c.text)
                .join("\n") || "Tool execution failed";
              reject(new Error(errorText));
            } else {
              resolve({ content: response.content, details: undefined });
            }
          },
          reject: (err) => { cleanup(); reject(err); },
          onUpdate: (update) => {
            onUpdate?.({ content: update.content, details: undefined });
          },
        });

        output({
          type: "tool_execute_request",
          id: requestId,
          toolCallId,
          toolName: reg.name,
          args: params,
        });
      });
    },
  };
}
```

### Input Routing (in handleInputLine)

```typescript
if (parsed.type === "tool_execute_response") {
  const p = pendingToolExecutions.get(parsed.id);
  if (p) {
    p.resolve({ content: parsed.content, isError: parsed.isError ?? false });
  }
  return;
}

if (parsed.type === "tool_execute_update") {
  const p = pendingToolExecutions.get(parsed.id);
  if (p) {
    p.onUpdate({ content: parsed.content });
  }
  return;
}
```

### Command Handling

```typescript
case "register_tool": {
  if (session.isStreaming) {
    return error(id, "register_tool", "Cannot register tools while agent is streaming");
  }
  const reg = command.tool;
  const bridgeTool = createRpcBridgeTool(reg, output, pendingToolExecutions);
  clientTools.set(reg.name, reg);
  session.addCustomTool(bridgeTool);
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
```

Registration is rejected during streaming to avoid mutating the tool registry mid-turn.

## RpcClient Additions

```typescript
interface RpcToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema
  promptSnippet?: string;
  promptGuidelines?: string[];
}

interface ToolExecuteRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  signal: AbortSignal;                    // fires on tool_execute_cancel
}

interface ToolExecuteResult {
  content: (TextContent | ImageContent)[];
  isError?: boolean;
}

class RpcClient {
  async registerTool(tool: RpcToolDefinition): Promise<void>;
  async unregisterTool(toolName: string): Promise<void>;

  // Set the handler for tool execution requests.
  // Only one handler at a time. The handler dispatches by toolName internally.
  onToolExecute(
    handler: (request: ToolExecuteRequest) => Promise<ToolExecuteResult>
  ): () => void;
}
```

Internally, `onToolExecute` hooks into `handleLine`:
- On `tool_execute_request`: creates an `AbortController`, stores it keyed by request id, calls the handler with `{ ..., signal: controller.signal }`, sends `tool_execute_response` with the result (or `isError: true` if the handler throws).
- On `tool_execute_cancel`: calls `controller.abort()` on the stored controller. The handler can observe this via the signal.

## What Doesn't Cross the Boundary

- **`renderCall` / `renderResult`**: Requires TUI `Component` factories. Client tools get default rendering (args JSON + result text). The client interprets `tool_execution_*` events for its own rendering.
- **`details`**: Always `undefined` for client tools. The `details` field is for server-side rendering; the client can embed structured data in `content` text if needed.
- **`prepareArguments`**: Not exposed. JSON Schema validation handles type coercion. If a tool needs arg preparation, the client can do it in its `onToolExecute` handler before returning.
- **`ExtensionContext` in `execute()`**: Server-side tool `execute` receives a context object. Client tools don't -- they have their own client-side state. If a client tool needs server state (e.g., model info, cwd), it can query via existing RPC commands (`get_state`).

## Cancellation

No timeout on `tool_execute_request`. The client has full control over execution duration. The only automatic resolution is agent abort:
- Agent abort fires the `signal` abort listener in the bridge tool
- Bridge tool sends `tool_execute_cancel` to the client and rejects with an error
- Agent loop catches the rejection and produces an `isError: true` tool result
