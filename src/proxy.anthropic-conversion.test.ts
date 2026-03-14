import { describe, expect, it } from "vitest";
import { convertToAnthropicFormat, convertAnthropicResponseToOpenAI } from "./proxy.js";

describe("convertToAnthropicFormat", () => {
  it("converts basic messages and extracts system", () => {
    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 1024,
    });

    expect(result.model).toBe("claude-sonnet-4.6");
    expect(result.system).toBe("You are helpful.");
    expect(result.max_tokens).toBe(1024);
    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("converts OpenAI tool definitions to Anthropic format", () => {
    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Search for cats" }],
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            description: "Search the web",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        },
      ],
    });

    expect(result.tools).toEqual([
      {
        name: "web_search",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
  });

  it("passes through tools already in Anthropic format", () => {
    const anthropicTool = {
      name: "my_tool",
      description: "A tool",
      input_schema: { type: "object", properties: {} },
    };

    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tools: [anthropicTool],
    });

    expect(result.tools).toEqual([anthropicTool]);
  });

  it("converts assistant tool_calls to tool_use content blocks", () => {
    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [
        { role: "user", content: "Search for cats" },
        {
          role: "assistant",
          content: "I'll search for that.",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "web_search",
                arguments: '{"query": "cats"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_123",
          content: "Found 10 results about cats.",
        },
        { role: "user", content: "Tell me more" },
      ],
    });

    const messages = result.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(3);

    // First: user message
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Search for cats");

    // Second: assistant with tool_use blocks
    expect(messages[1].role).toBe("assistant");
    const assistantContent = messages[1].content as Array<Record<string, unknown>>;
    expect(assistantContent).toHaveLength(2);
    expect(assistantContent[0]).toEqual({ type: "text", text: "I'll search for that." });
    expect(assistantContent[1]).toEqual({
      type: "tool_use",
      id: "call_123",
      name: "web_search",
      input: { query: "cats" },
    });

    // Third: tool result merged into user message, then user message merged too
    // (consecutive user messages get merged by the merging logic)
    expect(messages[2].role).toBe("user");
    const userContent = messages[2].content as Array<Record<string, unknown>>;
    expect(userContent).toHaveLength(2);
    expect(userContent[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_123",
      content: "Found 10 results about cats.",
    });
    expect(userContent[1]).toEqual({ type: "text", text: "Tell me more" });
  });

  it("converts tool_choice 'auto' to Anthropic format", () => {
    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: "auto",
    });

    expect(result.tool_choice).toEqual({ type: "auto" });
  });

  it("converts tool_choice 'required' to Anthropic 'any'", () => {
    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: "required",
    });

    expect(result.tool_choice).toEqual({ type: "any" });
  });

  it("omits tool_choice for 'none'", () => {
    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: "none",
    });

    expect(result.tool_choice).toBeUndefined();
  });

  it("converts specific function tool_choice to Anthropic format", () => {
    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: {
        type: "function",
        function: { name: "web_search" },
      },
    });

    expect(result.tool_choice).toEqual({ type: "tool", name: "web_search" });
  });

  it("merges consecutive same-role messages", () => {
    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [
        { role: "user", content: "Hello" },
        { role: "user", content: "How are you?" },
      ],
    });

    const messages = result.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    const content = messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
  });

  it("preserves stream and temperature", () => {
    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
    });

    expect(result.stream).toBe(true);
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
  });

  it("defaults max_tokens to 4096", () => {
    const result = convertToAnthropicFormat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(result.max_tokens).toBe(4096);
  });
});

describe("convertAnthropicResponseToOpenAI", () => {
  it("converts basic text response", () => {
    const result = convertAnthropicResponseToOpenAI({
      id: "msg_123",
      model: "claude-sonnet-4.6",
      content: [{ type: "text", text: "Hello there!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    expect(result.id).toBe("msg_123");
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("claude-sonnet-4.6");

    const choices = result.choices as Array<Record<string, unknown>>;
    expect(choices).toHaveLength(1);

    const message = choices[0].message as Record<string, unknown>;
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("Hello there!");
    expect(choices[0].finish_reason).toBe("stop");

    const usage = result.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
    expect(usage.total_tokens).toBe(15);
  });

  it("converts tool_use response blocks to OpenAI tool_calls", () => {
    const result = convertAnthropicResponseToOpenAI({
      id: "msg_456",
      model: "claude-sonnet-4.6",
      content: [
        { type: "text", text: "Let me search for that." },
        {
          type: "tool_use",
          id: "toolu_123",
          name: "web_search",
          input: { query: "cats" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 15 },
    });

    const choices = result.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;

    expect(message.content).toBe("Let me search for that.");
    expect(message.tool_calls).toEqual([
      {
        id: "toolu_123",
        type: "function",
        function: {
          name: "web_search",
          arguments: '{"query":"cats"}',
        },
      },
    ]);
    expect(choices[0].finish_reason).toBe("tool_calls");
  });

  it("maps stop_reason 'max_tokens' to 'length'", () => {
    const result = convertAnthropicResponseToOpenAI({
      id: "msg_789",
      model: "claude-sonnet-4.6",
      content: [{ type: "text", text: "Truncated..." }],
      stop_reason: "max_tokens",
    });

    const choices = result.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("length");
  });

  it("handles multiple tool_use blocks", () => {
    const result = convertAnthropicResponseToOpenAI({
      id: "msg_multi",
      model: "claude-sonnet-4.6",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "web_search",
          input: { query: "dogs" },
        },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "web_fetch",
          input: { url: "https://example.com" },
        },
      ],
      stop_reason: "tool_use",
    });

    const choices = result.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;

    expect(toolCalls).toHaveLength(2);
    expect((toolCalls[0].function as Record<string, unknown>).name).toBe("web_search");
    expect((toolCalls[1].function as Record<string, unknown>).name).toBe("web_fetch");
  });

  it("handles empty content", () => {
    const result = convertAnthropicResponseToOpenAI({
      id: "msg_empty",
      model: "claude-sonnet-4.6",
      content: [],
      stop_reason: "end_turn",
    });

    const choices = result.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    expect(message.content).toBeNull();
  });
});
