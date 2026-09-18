import type { AgentToolDefinition } from "../../types";
import { readAgentConversationMessages } from "../../store/transcriptStore";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { fail, ok } from "../shared";
import { readTextChunk } from "./textChunk";

type ConversationReadInput = {
  messageId?: string;
  offset: number;
  textOffset: number;
  maxTokens: number;
};

export function createConversationReadTool(): AgentToolDefinition<
  ConversationReadInput,
  unknown
> {
  return {
    spec: {
      name: "conversation_read",
      description:
        "Read exact prior conversation content after compression. Omit messageId to list messages (newest first, offset); provide messageId to read its text. Follow nextTextOffset using textOffset for long messages. To save an unchanged assistant answer, pass its messageId directly to note_write as sourceMessageId; no body transcription is needed.",
      executionClass: "read",
      workCategory: "retrieval",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          messageId: { type: "string" },
          offset: { type: "integer" },
          textOffset: { type: "integer" },
          maxTokens: { type: "integer", minimum: 512, maximum: 24000 },
        },
      },
    },
    validate(args) {
      if (!args || typeof args !== "object" || Array.isArray(args))
        return fail("conversation_read expects an object");
      const record = args as Record<string, unknown>;
      for (const key of ["offset", "textOffset", "maxTokens"])
        if (
          record[key] !== undefined &&
          (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0)
        )
          return fail(`${key} must be a nonnegative integer`);
      if (
        record.messageId !== undefined &&
        (typeof record.messageId !== "string" || !record.messageId.trim())
      )
        return fail("messageId must be a nonempty string");
      return ok({
        messageId: record.messageId as string | undefined,
        offset: Number(record.offset || 0),
        textOffset: Number(record.textOffset || 0),
        maxTokens: Math.max(
          512,
          Math.min(24000, Number(record.maxTokens || 6000)),
        ),
      });
    },
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        effects: ["read"],
        reason: "Read stored content in this conversation.",
      }),
    async execute(input, context) {
      const messages = (
        await readAgentConversationMessages(context.request.conversationKey)
      )
        .filter(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            message.messageId,
        )
        .reverse();
      const contentText = (content: (typeof messages)[number]["content"]) =>
        typeof content === "string"
          ? content
          : content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("\n");
      if (input.messageId) {
        const message = messages.find(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            message.messageId === input.messageId,
        );
        if (!message)
          return {
            ok: false,
            error: "Message not found in this conversation.",
          };
        return {
          ok: true,
          messageId: input.messageId,
          role: message.role,
          ...readTextChunk(
            contentText(message.content),
            input.textOffset,
            input.maxTokens - 128,
          ),
        };
      }
      const selected = messages.slice(input.offset, input.offset + 5);
      const nextOffset = input.offset + selected.length;
      return {
        ok: true,
        totalCount: messages.length,
        messages: selected.map((message) => ({
          messageId: (message as { messageId?: string }).messageId,
          role: message.role,
          totalChars: contentText(message.content).length,
          preview: contentText(message.content).slice(0, 160),
        })),
        ...(nextOffset < messages.length ? { nextOffset } : {}),
      };
    },
  };
}
