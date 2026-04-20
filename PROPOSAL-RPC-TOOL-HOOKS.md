# Proposal: Tool Event Hooks over RPC

## Goal

Expose the existing `tool_call` (pre-execution) and `tool_result` (post-execution) hook mechanisms over the RPC protocol. This lets RPC clients block tool calls, rewrite arguments, and modify results -- the same capabilities server-side extensions have via `on("tool_call", ...)` and `on("tool_result", ...)`.

This proposal is independent of client-implemented tools. It works on all tools regardless of where they're defined.

## Background: What Exists Today

Two separate hook mechanisms exist, only one is accessible over RPC:

| Mechanism | Can modify? | Available over RPC? |
|---|---|---|
| `tool_call` / `tool_result` extension events | Yes (block, rewrite args, rewrite result) | No -- extension runner only |
| `tool_execution_start/update/end` agent events | No -- read-only notifications | Yes -- streamed to RPC client |

This proposal bridges the first row into the RPC protocol.

## Execution Order

RPC hooks run after extension handlers. Extensions get first say. The RPC client sees args/results as already modified by extensions:

```
agent-loop beforeToolCall
  -> AgentSession._installAgentToolHooks
    -> extensionRunner.emitToolCall (server-side extensions, may mutate args or block)
    -> rpcToolCallHook (RPC client, may mutate args or block)
  <- return to agent-loop

agent-loop execute tool

agent-loop afterToolCall
  -> AgentSession._installAgentToolHooks
    -> extensionRunner.emitToolResult (server-side extensions, may modify result)
    -> rpcToolResultHook (RPC client, may modify result)
  <- return to agent-loop
```

## Protocol Additions

### New Commands (client -> server, stdin)

```typescript
// Subscribe to tool hooks. Replaces any previous subscription.
| {
    id?: string;
    type: "subscribe_tool_hooks";
    hooks: {
      tool_call?: boolean;
      tool_result?: boolean;
    };
    toolNames?: string[];   // filter to specific tools; omit = all tools
  }

// Unsubscribe from all tool hooks
| { id?: string; type: "unsubscribe_tool_hooks" }

// Response to a tool_call hook request
| {
    type: "tool_call_hook_response";
    id: string;
    block?: boolean;
    reason?: string;
    args?: Record<string, unknown>;   // replacement args; omit = keep current
  }

// Response to a tool_result hook request
| {
    type: "tool_result_hook_response";
    id: string;
    content?: (TextContent | ImageContent)[];   // omit = keep current
    isError?: boolean;                           // omit = keep current
  }
```

### New Events (server -> client, stdout)

```typescript
// Server asks client to evaluate a tool call before execution
| {
    type: "tool_call_hook_request";
    id: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }

// Server asks client to evaluate a tool result after execution
| {
    type: "tool_result_hook_request";
    id: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    content: (TextContent | ImageContent)[];
    isError: boolean;
  }
```

### New Responses (server -> client, stdout)

```typescript
| { id?: string; type: "response"; command: "subscribe_tool_hooks"; success: true }
| { id?: string; type: "response"; command: "unsubscribe_tool_hooks"; success: true }
```

## Arg Mutation Semantics

The existing extension `tool_call` hook mutates `event.input` in place. The agent loop passes `validatedArgs` by reference to `beforeToolCall`, stores the same reference in `PreparedToolCall.args`, and later passes it to `tool.execute()`. Mutations to the object are visible downstream.

For the RPC hook, `tool_call_hook_response.args` (if provided) replaces properties on the same object reference:

```typescript
if (response.args) {
  for (const key of Object.keys(argsRef)) delete argsRef[key];
  Object.assign(argsRef, response.args);
}
```

This matches how an extension handler would do `Object.assign(event.input, newArgs)`.

## AgentSession Changes

Add a slot for external hook callbacks and compose them with extension hooks in `_installAgentToolHooks`.

### New Types

```typescript
interface ExternalToolHooks {
  onToolCall?: (event: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;   // same object reference; mutate in place
  }) => Promise<{ block?: boolean; reason?: string } | undefined>;

  onToolResult?: (event: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    content: (TextContent | ImageContent)[];
    isError: boolean;
  }) => Promise<{ content?: (TextContent | ImageContent)[]; isError?: boolean } | undefined>;
}
```

### New Public Method

```typescript
setExternalToolHooks(hooks: ExternalToolHooks): void {
  this._externalToolHooks = hooks;
}
```

### Modified _installAgentToolHooks

```typescript
private _installAgentToolHooks(): void {
  this.agent.beforeToolCall = async ({ toolCall, args }) => {
    // 1. Extension runner hooks (existing, unchanged)
    const runner = this._extensionRunner;
    let extensionResult: BeforeToolCallResult | undefined;
    if (runner?.hasHandlers("tool_call")) {
      await this._agentEventQueue;
      try {
        extensionResult = await runner.emitToolCall({
          type: "tool_call",
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          input: args as Record<string, unknown>,
        });
        if (extensionResult?.block) return extensionResult;
      } catch (err) {
        if (err instanceof Error) throw err;
        throw new Error(`Extension failed, blocking execution: ${String(err)}`);
      }
    }

    // 2. External hooks (RPC)
    if (this._externalToolHooks?.onToolCall) {
      const externalResult = await this._externalToolHooks.onToolCall({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: args as Record<string, unknown>,
      });
      if (externalResult?.block) return externalResult;
    }

    return extensionResult;
  };

  this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
    // 1. Extension runner hooks (existing, unchanged)
    const runner = this._extensionRunner;
    let currentResult = result;
    let currentIsError = isError;

    if (runner?.hasHandlers("tool_result")) {
      const hookResult = await runner.emitToolResult({
        type: "tool_result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        input: args as Record<string, unknown>,
        content: result.content,
        details: isError ? undefined : result.details,
        isError,
      });

      if (hookResult && !isError) {
        if (hookResult.content) currentResult = { ...currentResult, content: hookResult.content };
        if (hookResult.details !== undefined) currentResult = { ...currentResult, details: hookResult.details };
        if (hookResult.isError !== undefined) currentIsError = hookResult.isError;
      }
    }

    // 2. External hooks (RPC) -- sees post-extension content/isError
    if (this._externalToolHooks?.onToolResult) {
      const externalResult = await this._externalToolHooks.onToolResult({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: args as Record<string, unknown>,
        content: currentResult.content,
        isError: currentIsError,
      });

      if (externalResult) {
        return {
          content: externalResult.content ?? currentResult.content,
          details: currentResult.details,
          isError: externalResult.isError ?? currentIsError,
        };
      }
    }

    // Return extension modifications if any were made
    if (currentResult !== result || currentIsError !== isError) {
      return { content: currentResult.content, details: currentResult.details, isError: currentIsError };
    }
    return undefined;
  };
}
```

## rpc-mode.ts Changes

### State

```typescript
let toolHookSubscription: {
  toolCall: boolean;
  toolResult: boolean;
  toolNames: Set<string> | null;   // null = all tools
} | null = null;

const pendingToolHooks = new Map<string, {
  resolve: (result: any) => void;
}>();
```

### Hook Wiring (called from rebindSession)

```typescript
function installRpcToolHooks(): void {
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
          resolve: (response) => {
            signal?.removeEventListener("abort", onAbort);
            pendingToolHooks.delete(hookId);
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
        });
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
          resolve: (response) => {
            signal?.removeEventListener("abort", onAbort);
            pendingToolHooks.delete(hookId);
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
        });
      });
    },
  });
}
```

### Input Routing (in handleInputLine)

```typescript
if (parsed.type === "tool_call_hook_response" || parsed.type === "tool_result_hook_response") {
  const pending = pendingToolHooks.get(parsed.id);
  if (pending) {
    pending.resolve(parsed);
  }
  return;
}
```

### Command Handling

```typescript
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
```

## RpcClient Additions

```typescript
class RpcClient {
  async subscribeToolHooks(options: {
    toolCall?: boolean;
    toolResult?: boolean;
    toolNames?: string[];
  }): Promise<void>;

  async unsubscribeToolHooks(): Promise<void>;

  onToolCallHook(
    handler: (request: {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }) => Promise<{
      block?: boolean;
      reason?: string;
      args?: Record<string, unknown>;
    } | undefined>
  ): () => void;

  onToolResultHook(
    handler: (request: {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      content: (TextContent | ImageContent)[];
      isError: boolean;
    }) => Promise<{
      content?: (TextContent | ImageContent)[];
      isError?: boolean;
    } | undefined>
  ): () => void;
}
```

Internally, `onToolCallHook`/`onToolResultHook` register handlers that `handleLine` dispatches to when it sees `tool_call_hook_request`/`tool_result_hook_request`. The handler's return value is serialized as the corresponding `*_hook_response`.

## Cancellation

No timeout. The client has ultimate authority over hooks. The only way a pending hook resolves without a client response is agent abort -- the `signal` abort listener resolves the promise with `undefined` (no modification, no block), allowing the agent loop to clean up normally.

## Examples

### Permission Gate (tool_call hook, blocking)

```
-> {"type":"subscribe_tool_hooks","hooks":{"tool_call":true},"toolNames":["bash","write","edit"],"id":"1"}
<- {"type":"response","command":"subscribe_tool_hooks","success":true,"id":"1"}

... LLM calls bash with rm -rf / ...

<- {"type":"tool_execution_start","toolCallId":"tc_1","toolName":"bash","args":{"command":"rm -rf /"}}
<- {"type":"tool_call_hook_request","id":"h1","toolCallId":"tc_1","toolName":"bash","args":{"command":"rm -rf /"}}
-> {"type":"tool_call_hook_response","id":"h1","block":true,"reason":"Blocked: destructive command"}
<- {"type":"tool_execution_end","toolCallId":"tc_1","toolName":"bash","result":{"content":[{"type":"text","text":"Blocked: destructive command"}]},"isError":true}
```

### Arg Rewriting (tool_call hook)

```
<- {"type":"tool_call_hook_request","id":"h2","toolCallId":"tc_2","toolName":"bash","args":{"command":"npm test"}}
-> {"type":"tool_call_hook_response","id":"h2","args":{"command":"npm test -- --reporter=json"}}
<- {"type":"tool_execution_end","toolCallId":"tc_2","toolName":"bash","result":{...},"isError":false}
```

### Result Redaction (tool_result hook)

```
-> {"type":"subscribe_tool_hooks","hooks":{"tool_result":true},"toolNames":["read"],"id":"1"}

... LLM reads a file ...

<- {"type":"tool_result_hook_request","id":"h3","toolCallId":"tc_3","toolName":"read","args":{"path":"secrets.env"},"content":[{"type":"text","text":"API_KEY=sk-123"}],"isError":false}
-> {"type":"tool_result_hook_response","id":"h3","content":[{"type":"text","text":"API_KEY=<redacted>"}]}
```

### Pass-Through (no modification)

```
<- {"type":"tool_call_hook_request","id":"h4","toolCallId":"tc_4","toolName":"read","args":{"path":"README.md"}}
-> {"type":"tool_call_hook_response","id":"h4"}
```

## File Changes Summary

| File | Changes |
|---|---|
| `rpc-types.ts` | New command types (`subscribe_tool_hooks`, `unsubscribe_tool_hooks`); new input types (`tool_call_hook_response`, `tool_result_hook_response`); new event types (`tool_call_hook_request`, `tool_result_hook_request`); corresponding response types |
| `rpc-mode.ts` | Hook subscription state; pending hook map; hook wiring function; input routing for hook responses; command handlers for subscribe/unsubscribe |
| `rpc-client.ts` | `subscribeToolHooks()`, `unsubscribeToolHooks()`, `onToolCallHook()`, `onToolResultHook()` |
| `agent-session.ts` | `ExternalToolHooks` interface; `setExternalToolHooks()` method; modified `_installAgentToolHooks()` to compose extension + external hooks |
