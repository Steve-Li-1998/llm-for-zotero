import { renderLibraryOverviewSection } from "../context/libraryOverview";

import type {
  AgentContentInputCapabilities,
  AgentModelContentPart,
  AgentModelMessage,
  AgentRuntimeRequest,
  AgentSystemMessage,
  AgentToolDefinition,
  AgentUserMessage,
} from "../types";
import { AGENT_PERSONA_INSTRUCTIONS } from "./agentPersona";
import { buildAgentMemoryBlock } from "../store/conversationMemory";
import { buildSkillInventory, getAllSkills } from "../skills";
import type { AgentSkill } from "../skills";
import { getSkillCustomizationNotice } from "../skills/managedBlock";
import { getOriginalAgentPermissionMode } from "../originalAgentPermissionMode";
import { buildPermissionModeGuidance } from "./permissionModeGuidance";

import { resolveProviderCapabilities } from "../../providers";
import type { ProviderCapabilities } from "../../providers";
import { buildNotesDirectoryConfigSection } from "../../utils/notesDirectoryConfig";
import { NOTE_EDITING_QUOTE_BLOCK_GUIDANCE } from "../../shared/quoteGuidance";
import { buildRuntimePlatformGuidanceText } from "../../utils/runtimePlatform";
import { formatPaperSourceLabel } from "../../modules/contextPanel/paperAttribution";
import {
  buildQuoteAnchorPromptBlock,
  buildSelectedTextQuoteCitations,
} from "../../modules/contextPanel/quoteCitations";
import {
  buildAgentStableResourceContextBlock,
  type AgentResourceContextPlan,
} from "../context/resourceContextPlan";
import {
  buildAgentCoverageContextBlock,
  listVisibleAgentCoverageEntries,
} from "../context/coverageLedger";
import {
  renderTurnReadingRule,
  resolveTurnEvidencePolicy,
} from "../context/evidencePolicy";
import { buildVisibleTurnContextBlock } from "../context/turnContextEnvelope";
import { getSelectedPassagePaper } from "../context/turnPaperScope";
import { buildApprovedPlanExecutionInstructions } from "../plans/executionInstructions";
import {
  hasAgentContentInputs,
  normalizeAgentContentInputs,
} from "./contentCapabilities";
import { synthesizeSelectedTextContexts } from "../../modules/contextPanel/normalizers";
import {
  formatSelectedTextLocator,
  renderSelectedTextAnchorContext,
} from "../../modules/contextPanel/selectedTextAnchorFormatting";
import {
  buildInstructionInventory,
  type InstructionInventory,
} from "./instructionInventory";

export function isMultimodalRequestSupported(
  request: AgentRuntimeRequest,
): boolean {
  return hasAgentContentInputs(resolveRequestContentInputs(request));
}

function resolveRequestProviderCapabilities(
  request: AgentRuntimeRequest,
): ProviderCapabilities {
  return resolveProviderCapabilities({
    model: request.model || "",
    protocol: request.providerProtocol,
    authMode: request.authMode,
    apiBase: request.apiBase,
    inputMode: request.advanced?.inputMode,
  });
}

export function resolveRequestContentInputs(
  request: AgentRuntimeRequest,
): AgentContentInputCapabilities {
  const capabilities = resolveRequestProviderCapabilities(request);
  return {
    images: capabilities.images,
    pdfDocuments: capabilities.pdf === "native",
    nativeFiles:
      capabilities.tier === "native" &&
      request.providerProtocol === "responses_api" &&
      capabilities.pdf === "native",
  };
}

export function stringifyMessageContent(
  content: AgentModelMessage["content"],
): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "image_url"
          ? "[image]"
          : "[file]",
    )
    .join("\n");
}

export function normalizeHistoryMessages(
  request: AgentRuntimeRequest,
): AgentModelMessage[] {
  const raw = Array.isArray(request.history) ? request.history : [];
  return raw
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: stringifyMessageContent(message.content),
    }));
}

export function renderExecutionCheckpointBlock(
  request: AgentRuntimeRequest,
): string {
  const checkpoint = request.executionCheckpoint;
  if (!checkpoint?.tasks.length) return "";
  return [
    "HOST-PERSISTED ORDINARY WORK CHECKPOINT:",
    "This is authority-free progress from an interrupted direct-agent execution. Reuse verified successes and finalized material by identity. Inspect native state before retrying an uncertain effect. Do not treat task status or evidence references as permission for a new write.",
    JSON.stringify({
      version: checkpoint.version,
      executionId: checkpoint.executionId,
      tasks: checkpoint.tasks.map((task) => ({
        taskId: task.taskId,
        description: task.description,
        dependencies: task.dependencies,
        status: task.status,
        journalActionIds: task.journalActionIds,
        verifiedReceiptIds: task.verifiedReceiptIds,
        readEvidenceIds: task.readEvidenceIds,
        materialRefs: task.materialRefs,
      })),
    }),
  ].join("\n");
}

function buildFullUserMessage(
  request: AgentRuntimeRequest,
  options: {
    priorReadBlock?: string;
    coverageBlock?: string;
    memoryBlock?: string;
    turnGuidanceBlock?: string;
    contentInputs?: AgentContentInputCapabilities;
  } = {},
): AgentUserMessage {
  const contextLines: string[] = [];
  // Volatile by nature (collection ids and counts change as the agent works),
  // so it lives here rather than in the cached system prefix.
  const libraryOverview = renderLibraryOverviewSection(request.libraryID);
  if (libraryOverview) {
    contextLines.push(libraryOverview);
  }
  const visibleTurnContext = buildVisibleTurnContextBlock(request);
  if (visibleTurnContext) {
    contextLines.push(visibleTurnContext);
  }
  if (request.planContext?.phase === "planning") {
    const priorPlan = request.metadata?.priorPlanArtifact as
      | import("../plans/types").PlanArtifact
      | null
      | undefined;
    contextLines.push(
      [
        "PLAN MODE — pre-approval boundary:",
        `Plan identity: ${request.planContext.planId} revision ${request.planContext.revision}.`,
        "You may inspect Zotero context, PDFs, and read-only web/literature sources. You must not mutate Zotero, write files, run commands or scripts, import/upload data, change settings, or trigger any other side effect.",
        "Use request_user_input only for a material choice that cannot be discovered. Use update_plan for 3–7 concise, user-visible steps. Every acceptance criterion must provide a stable criterionId, an objective description, and its verifier; the host derives requirements from those criteria. Keep each step content to one short sentence. Then set ready=true and stop for user review.",
      ].join("\n"),
    );
    if (
      (priorPlan?.version === 4 || priorPlan?.version === 5) &&
      priorPlan.planId === request.planContext.planId &&
      priorPlan.revision === request.planContext.revision - 1
    ) {
      contextLines.push(
        [
          "HOST-PERSISTED PLAN REVISION BASE:",
          "Revise this exact contract and step list according to the user's feedback. Do not rediscover or reconstruct this plan, its frozen item scope, or unchanged evidence strategy from prior tool handles.",
          JSON.stringify({
            explanation: priorPlan.explanation,
            contract: priorPlan.contract,
            steps: priorPlan.steps.map((step) => ({
              planStepId: step.planStepId,
              content: step.content,
              activeForm: step.activeForm,
              acceptanceCriteria: step.acceptanceCriteria,
              expectedCapability: step.expectedCapability,
              expectedEffect: step.expectedEffect,
              targetBoundary: step.targetBoundary,
            })),
          }),
        ].join("\n"),
      );
    }
  } else if (request.planContext?.phase === "executing") {
    const ledger = request.metadata?.planExecutionLedger as
      | import("../plans/types").PlanExecutionLedger
      | null
      | undefined;
    const approvedContract = request.metadata?.approvedPlanContract as
      | import("../plans/types").PlanContract
      | null
      | undefined;
    if (ledger) {
      contextLines.push(
        buildApprovedPlanExecutionInstructions(ledger, approvedContract),
      );
    }
  }
  const executionCheckpoint = renderExecutionCheckpointBlock(request);
  if (executionCheckpoint) contextLines.push(executionCheckpoint);
  if (request.activeNoteContext) {
    const note = request.activeNoteContext;
    contextLines.push(
      `Current note content for this turn:\n"""\n${note.noteText}\n"""`,
    );
    contextLines.push(NOTE_EDITING_QUOTE_BLOCK_GUIDANCE);
    if (note.noteHtml) {
      contextLines.push(`Original note HTML:\n"""\n${note.noteHtml}\n"""`);
    }
  }
  const selectedTextContexts = synthesizeSelectedTextContexts({
    selectedTextContexts: request.selectedTextContexts,
    selectedTexts: request.selectedTexts,
    selectedTextSources: request.selectedTextSources,
    selectedTextPaperContexts: (request.selectedTextContexts || []).map(
      (_context, index) =>
        getSelectedPassagePaper(request.turnPaperScope, index),
    ),
    selectedTextNoteContexts: request.selectedTextNoteContexts,
  });
  const selectedTexts = selectedTextContexts.map((context) => context.text);
  const selectedTextSources = selectedTextContexts.map(
    (context) => context.source,
  );
  const selectedTextPaperContexts = selectedTextContexts.map(
    (_context, index) => getSelectedPassagePaper(request.turnPaperScope, index),
  );
  const anchorsByIndex = new Map(
    (request.resolvedSelectedTextAnchors || []).map((anchor) => [
      anchor.contextIndex,
      anchor,
    ]),
  );
  if (selectedTexts.length) {
    const selectedTextQuoteAnchors = buildQuoteAnchorPromptBlock(
      buildSelectedTextQuoteCitations(
        selectedTexts,
        selectedTextSources,
        selectedTextPaperContexts,
      ),
    );
    const selectedTextBlock = selectedTexts
      .map((entry, index) => {
        const source = selectedTextSources[index];
        const paperContext = selectedTextPaperContexts[index];
        const sourceLabel =
          source === "model"
            ? "model response"
            : source === "note"
              ? "Zotero note"
              : source === "note-edit"
                ? "active note editing focus"
                : "PDF reader";
        const noteContext = selectedTextContexts[index]?.noteContext;
        const sourceMeta =
          source === "pdf" && paperContext
            ? `, paper=${paperContext.title}, source_label=${formatPaperSourceLabel(paperContext)}`
            : source === "note-edit" && noteContext
              ? [
                  `, note=${noteContext.title}`,
                  noteContext.noteItemId
                    ? `note_id=${noteContext.noteItemId}`
                    : "",
                  `note_kind=${noteContext.noteKind}`,
                  noteContext.parentItemId
                    ? `parent_item_id=${noteContext.parentItemId}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(", ")
              : "";
        const locator = formatSelectedTextLocator(
          selectedTextContexts[index],
          anchorsByIndex.get(index),
        );
        return `Selected text ${index + 1} [source=${sourceLabel}${sourceMeta}]${locator ? ` ${locator}` : ""}:\n"""\n${entry}\n"""`;
      })
      .join("\n\n");
    contextLines.push(
      [...selectedTextQuoteAnchors, selectedTextBlock]
        .filter(Boolean)
        .join("\n\n"),
    );
    const anchorContext = renderSelectedTextAnchorContext({
      selectedTextContexts,
      anchors: [...(request.resolvedSelectedTextAnchors || [])],
    });
    if (anchorContext) contextLines.push(anchorContext);
  }
  const pdfAttachments = (request.attachments || []).filter(
    (a) =>
      a.category === "pdf" &&
      typeof a.storedPath === "string" &&
      a.storedPath.trim(),
  );
  const nonPdfAttachments = (request.attachments || []).filter(
    (a) => a.category !== "pdf",
  );
  if (nonPdfAttachments.length) {
    contextLines.push(
      "Current uploaded attachments are available through the registered document tools.",
    );
  }
  if (options.priorReadBlock) {
    contextLines.push(options.priorReadBlock);
  }
  if (options.coverageBlock) {
    contextLines.push(options.coverageBlock);
  }
  if (options.memoryBlock) {
    contextLines.push(options.memoryBlock);
  }
  if (request.clarificationHistory?.length) {
    contextLines.push(
      [
        "Clarifications supplied for this request:",
        ...request.clarificationHistory.map(
          (entry) => `- ${entry.question}: ${entry.answer}`,
        ),
      ].join("\n"),
    );
  }
  if (options.turnGuidanceBlock) {
    contextLines.push(options.turnGuidanceBlock);
  }

  const promptText = `${
    contextLines.length ? `${contextLines.join("\n")}\n\n` : ""
  }User request:\n${request.userText}`;
  const screenshots = Array.isArray(request.screenshots)
    ? request.screenshots.filter((entry) => Boolean(entry))
    : [];
  const contentInputs = normalizeAgentContentInputs(
    options.contentInputs || resolveRequestContentInputs(request),
  );
  const imageParts = contentInputs.images
    ? screenshots.map((url) => ({
        type: "image_url" as const,
        image_url: {
          url,
          detail: "high" as const,
        },
      }))
    : [];
  const pdfParts =
    contentInputs.pdfDocuments || contentInputs.nativeFiles
      ? pdfAttachments.map((a) => ({
          type: "file_ref" as const,
          file_ref: {
            name: a.name,
            mimeType: a.mimeType || "application/pdf",
            storedPath: a.storedPath as string,
            contentHash: a.contentHash,
          },
        }))
      : [];
  if (!imageParts.length && !pdfParts.length) {
    return {
      role: "user",
      content: promptText,
    };
  }
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: promptText,
      },
      ...imageParts,
      ...pdfParts,
    ],
  };
}

function buildUserMessage(
  request: AgentRuntimeRequest,
  resourceContextPlan?: AgentResourceContextPlan,
  options: {
    coverageBlock?: string;
    memoryBlock?: string;
    turnGuidanceBlock?: string;
    contentInputs?: AgentContentInputCapabilities;
  } = {},
): AgentUserMessage {
  return buildFullUserMessage(request, {
    priorReadBlock: resourceContextPlan?.priorReadBlock,
    coverageBlock: options.coverageBlock,
    memoryBlock: options.memoryBlock,
    turnGuidanceBlock: options.turnGuidanceBlock,
    contentInputs: options.contentInputs,
  });
}

type PromptSection = {
  /** Identifies the section in code; not emitted into the prompt text */
  id: string;
  lines: string[];
};

export type AgentPromptEnvelope = Readonly<{
  systemMessages: readonly Readonly<AgentSystemMessage>[];
  turnMessage: Readonly<AgentUserMessage>;
}>;

type AgentPromptInventoryState = Readonly<{
  fixedPrompt: string;
  tools: readonly AgentToolDefinition<any, any>[];
  matchedSkillInstructions: readonly string[];
  dynamicGuidance: string;
  stableResourceBlock: string;
  turnResource: string;
}>;

export type RenderedAgentPromptEnvelope = Readonly<{
  envelope: AgentPromptEnvelope;
  inventory: AgentPromptInventoryState;
}>;

function cloneContentPart(part: AgentModelContentPart): AgentModelContentPart {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image_url") {
    return {
      type: "image_url",
      image_url: {
        url: part.image_url.url,
        detail: part.image_url.detail,
      },
    };
  }
  return {
    type: "file_ref",
    file_ref: {
      name: part.file_ref.name,
      mimeType: part.file_ref.mimeType,
      storedPath: part.file_ref.storedPath,
      contentHash: part.file_ref.contentHash,
    },
  };
}

function cloneModelMessage(message: AgentModelMessage): AgentModelMessage {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content.map(cloneContentPart);
  if (message.role === "assistant") {
    return {
      ...message,
      content,
      tool_calls: message.tool_calls?.map((call) => ({ ...call })),
    };
  }
  return { ...message, content } as AgentModelMessage;
}

function freezeEnvelopeMessage<
  TMessage extends AgentSystemMessage | AgentUserMessage,
>(message: TMessage): Readonly<TMessage> {
  const cloned = cloneModelMessage(message) as TMessage;
  if (typeof cloned.content !== "string") {
    for (const part of cloned.content) {
      if (part.type === "image_url") Object.freeze(part.image_url);
      if (part.type === "file_ref") Object.freeze(part.file_ref);
      Object.freeze(part);
    }
    Object.freeze(cloned.content);
  }
  return Object.freeze(cloned);
}

function buildSystemPrompt(sections: PromptSection[]): string {
  return sections
    .flatMap(({ lines }) => lines)
    .filter(Boolean)
    .join("\n\n");
}

function collectToolGuidanceInstructions(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
  matchedSkillIds: ReadonlyArray<string>,
): string[] {
  const instructions = new Set<string>();
  const {
    userText: _userText,
    history: _history,
    clarificationHistory: _clarifications,
    ...guidanceContext
  } = request;
  for (const tool of tools) {
    const guidance = tool.guidance;
    if (!guidance) continue;
    if (!guidance.matches(guidanceContext, { matchedSkillIds })) continue;
    const instruction = guidance.instruction.trim();
    if (instruction) instructions.add(instruction);
  }

  if (!instructions.size) return [];
  return [
    "The following stable tool guidance is provided because the user's message may be relevant to these capabilities. " +
      "Use your judgement: only invoke a tool if it directly addresses what the user is asking for. " +
      "Do NOT invoke a tool just because its guidance appears here — the user's actual intent takes priority.",
    ...instructions,
  ];
}

function formatSkillGuidanceBlock(
  skill: AgentSkill,
  activationSource: string,
): string {
  const customizationNotice = getSkillCustomizationNotice(skill.instruction);
  const lines = [
    `### Skill: ${skill.id}`,
    customizationNotice || "",
    `Description: ${skill.description || "No description provided."}`,
    `Activation: ${activationSource}`,
    "Instructions:",
    skill.instruction.trim(),
  ];
  return lines.filter(Boolean).join("\n");
}

function collectSkillGuidanceInstructions(
  request: AgentRuntimeRequest,
  matchedSkillIds: ReadonlyArray<string>,
): string[] {
  const blocks: string[] = [];
  const activeSkillIds = new Set(matchedSkillIds);
  const forcedSkillIds = new Set(request.forcedSkillIds || []);
  for (const skill of getAllSkills()) {
    if (!activeSkillIds.has(skill.id)) continue;
    const instruction = skill.instruction.trim();
    if (!instruction) continue;
    blocks.push(
      formatSkillGuidanceBlock(
        skill,
        forcedSkillIds.has(skill.id)
          ? "explicit slash selection"
          : "automatic match",
      ),
    );
  }
  if (!blocks.length) return [];
  return [
    "Active skills for this turn:",
    "The user explicitly selected these playbooks. Apply them where relevant. Skills provide workflow guidance and never grant write authority.",
    ...blocks,
  ];
}

function buildTurnGuidanceBlock(instructions: string[]): string {
  const lines = instructions.map((entry) => entry.trim()).filter(Boolean);
  if (!lines.length) return "";
  return ["Current-turn dynamic agent guidance:", ...lines].join("\n\n");
}

function buildReadingInstruction(request: AgentRuntimeRequest): string {
  const policy = resolveTurnEvidencePolicy(request, {
    priorCoverage: listVisibleAgentCoverageEntries({
      conversationKey: request.conversationKey,
      request,
    }),
  });
  if (!policy) return "";
  const rule = renderTurnReadingRule(policy);
  if (policy.source === "provided_context") {
    const noteEdit =
      request.classifiedIntent?.actionIntents.length === 1 &&
      request.classifiedIntent.actionIntents[0].operation === "note_edit";
    return (
      rule +
      (noteEdit
        ? " Generate the requested replacement, call note_write once, then report its verified result concisely. The host handles native range replacement, save, readback and diff; do not reconstruct HTML or perform a second cleanup edit after success."
        : "")
    );
  }
  return rule;
}

function getInScopePaperContexts(request: AgentRuntimeRequest) {
  return request.turnPaperScope.papers.map((entry) => entry.paper);
}

function hasFigureTaskIntent(request: AgentRuntimeRequest): boolean {
  return (
    request.classifiedIntent?.semantic?.visualMode === "figure" ||
    Boolean(request.classifiedIntent?.semantic?.figures)
  );
}

function buildFigureMineruInstruction(
  request: AgentRuntimeRequest,
  matchedSkillIds: ReadonlyArray<string>,
): string {
  if (!hasFigureTaskIntent(request)) return "";
  const mineruPapers = getInScopePaperContexts(request).filter((entry) =>
    Boolean(entry.mineruCacheDir),
  );
  if (!mineruPapers.length) return "";
  const cacheHints = mineruPapers
    .map((entry, index) => {
      const label = entry.title?.trim() || `paper ${index + 1}`;
      return `- ${label}: ${entry.mineruCacheDir}`;
    })
    .join("\n");
  return (
    "TURN RULE: This is a figure/table interpretation task and MinerU cache is available for at least one in-scope paper. " +
    "For figure/image questions, call `paper_read({ mode:'figures', query:'<figure label or all figures>' })` first. This returns precise PDF crops plus captions/provenance. Treat that result as the authority for figure crop cache reuse/regeneration; use returned crop paths/artifacts as-is and do not inspect or validate `figure_crops` metadata before analysis or writing. " +
    "If figure extraction fails or returns no crops, switch to text-only mode for analysis, note taking, and follow-up artifacts: do not include figure images, rendered PDF page screenshots, MinerU source images, or extracted-image placeholders; explicitly state that extraction failed or no extracted crops are available and base explanations on captions, figure legends, and surrounding paper text. Manual user-provided image inputs are unaffected. " +
    "For table questions, call `paper_read({ mode:'targeted', query:'<table label and surrounding discussion>' })` because MinerU table evidence is text/structure, not figure crops. " +
    "Use `full.md`/manifest text for captions and surrounding textual evidence, but do not read or embed MinerU image paths for ordinary figure interpretation. " +
    "For explicit panel requests, inspect the whole extracted figure crop and treat panel suffixes as hints. " +
    "Use `paper_read({ mode:'visual', query:'<page/layout request>' })` only when the user explicitly asks for rendered/raw PDF pages, page screenshots, page layout, exact pages, or visible-reader inspection.\n" +
    `Available MinerU cache directories:\n${cacheHints}`
  );
}

function buildRuntimePlatformSection(): string {
  return buildRuntimePlatformGuidanceText();
}

function buildTextOnlyModelInstruction(
  request: AgentRuntimeRequest,
  matchedSkillIds: ReadonlyArray<string>,
): string {
  if (isMultimodalRequestSupported(request)) return "";
  const modelLabel = (request.model || "selected model").trim();
  if (!hasFigureTaskIntent(request)) {
    return request.screenshots?.length
      ? `MODEL LIMITATION: ${modelLabel} is text-only and cannot inspect the supplied screenshots.`
      : "";
  }
  return (
    `MODEL LIMITATION: ${modelLabel} is treated as text-only in this plugin. ` +
    "Do not rely on screenshots, PDF page images, or image-file visual inspection. " +
    "For MinerU-cached papers, prefer `manifest.json`, `full.md` section offsets, captions, tables, formulas, and surrounding extracted text. " +
    "For figure workflows, you may still call `paper_read({ mode:'figures' })` to obtain extracted crop paths, captions, warnings, and provenance for note embedding. Treat that result as the authority for figure crop cache reuse/regeneration; do not inspect or validate `figure_crops` metadata before analysis or writing. Do not make unsupported visual claims unless an image-capable model inspected the crop."
  );
}

export async function renderAgentPromptEnvelope(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
  matchedSkillIds: ReadonlyArray<string>,
  resourceContextPlan?: AgentResourceContextPlan,
  options: {
    contentInputs?: AgentContentInputCapabilities;
  } = {},
): Promise<RenderedAgentPromptEnvelope> {
  const memoryBlock = await buildAgentMemoryBlock(request.conversationKey);
  const autoReadInstruction = buildReadingInstruction(request);
  const workflowParityInstructions = [
    buildFigureMineruInstruction(request, matchedSkillIds),
  ].filter(Boolean);
  const dynamicGuidanceInstructions = [
    autoReadInstruction,
    ...workflowParityInstructions,
    ...collectToolGuidanceInstructions(request, tools, matchedSkillIds),
  ];
  const matchedSkillInstructions = collectSkillGuidanceInstructions(
    request,
    matchedSkillIds,
  );
  const turnGuidanceBlock = buildTurnGuidanceBlock([
    ...buildPermissionModeGuidance(getOriginalAgentPermissionMode(), []),
    ...dynamicGuidanceInstructions,
    ...matchedSkillInstructions,
  ]);
  const coverageBlock = buildAgentCoverageContextBlock({
    conversationKey: request.conversationKey,
    request,
  });

  const sections: PromptSection[] = [
    {
      id: "system-override",
      lines: [(request.systemPrompt || "").trim()],
    },
    {
      id: "persona",
      lines: AGENT_PERSONA_INSTRUCTIONS,
    },
    {
      id: "direct-agent-workflow",
      lines: [
        [
          "## Direct agent workflow",
          "Understand the current request yourself and choose the lightest useful sequence of reads, searches, questions, document finalization, and concrete actions.",
          "Use actual tools for requested effects. Inspect results and continue until the requested outcome is complete, reviewed, or has a concrete error.",
          "Natural-language restrictions in the current request and clarifications remain binding. Tool calls do not grant their own permission; the host validates each concrete proposal, applies permission policy, journals effects, and verifies native state.",
          "Resolve named targets from supplied identities or bounded search results. If several candidates remain, use request_user_input rather than guessing.",
        ].join("\n"),
      ],
    },
    {
      id: "skill-inventory",
      lines: [
        `Installed skill inventory (load full instructions with load_skill when useful): ${JSON.stringify(
          buildSkillInventory(getAllSkills()),
        )}`,
      ],
    },
    {
      id: "runtime-platform",
      lines: [buildRuntimePlatformSection()],
    },
    {
      id: "model-limitations",
      lines: [buildTextOnlyModelInstruction(request, matchedSkillIds)],
    },
    {
      id: "custom-instructions",
      lines: [(request.customInstructions || "").trim()],
    },
    {
      id: "notes-directory-config",
      lines: [buildNotesDirectoryConfigSection()],
    },
  ];
  // The library overview is deliberately NOT a system section.
  //
  // The cache breakpoint sits at the last "stable-prefix" block, so every
  // system section is inside the cached prefix. This section names collection
  // ids and a collection count, both of which change the moment the agent
  // creates a folder — which would invalidate the prompt cache on the next
  // turn, for Anthropic's explicit caching and for the automatic prefix
  // caching DeepSeek and Kimi do. It belongs with the other volatile
  // per-turn context instead; see buildAgentTurnUserMessage.
  const stableResourceBlock =
    resourceContextPlan?.stableContextBlock ||
    buildAgentStableResourceContextBlock(request);

  const fixedPrompt = buildSystemPrompt(sections);
  const turnMessage = buildUserMessage(request, resourceContextPlan, {
    coverageBlock,
    memoryBlock,
    turnGuidanceBlock,
    contentInputs: options.contentInputs,
  });
  const systemMessages = [
    freezeEnvelopeMessage<AgentSystemMessage>({
      role: "system",
      content: fixedPrompt,
    }),
    ...(stableResourceBlock
      ? [
          freezeEnvelopeMessage<AgentSystemMessage>({
            role: "system",
            content: stableResourceBlock,
            cachePolicy: "stable-prefix",
          }),
        ]
      : []),
  ];
  const frozenTurnMessage = freezeEnvelopeMessage(turnMessage);
  const turnText = stringifyMessageContent(turnMessage.content);
  return Object.freeze({
    envelope: Object.freeze({
      systemMessages: Object.freeze(systemMessages),
      turnMessage: frozenTurnMessage,
    }),
    inventory: Object.freeze({
      fixedPrompt,
      tools: Object.freeze([...tools]),
      matchedSkillInstructions: Object.freeze([...matchedSkillInstructions]),
      dynamicGuidance: buildTurnGuidanceBlock(dynamicGuidanceInstructions),
      stableResourceBlock,
      turnResource: turnGuidanceBlock
        ? turnText.replace(turnGuidanceBlock, "").trim()
        : turnText,
    }),
  });
}

export function composeAgentModelInput(
  envelope: AgentPromptEnvelope,
  options: {
    transcriptMessages?: readonly AgentModelMessage[];
    postTurnMessages?: readonly AgentModelMessage[];
  } = {},
): AgentModelMessage[] {
  return [
    ...envelope.systemMessages.map((message) =>
      cloneModelMessage(message as AgentSystemMessage),
    ),
    ...(options.transcriptMessages || []).map(cloneModelMessage),
    cloneModelMessage(envelope.turnMessage as AgentUserMessage),
    ...(options.postTurnMessages || []).map(cloneModelMessage),
  ];
}

export function buildAgentPromptInstructionInventory(
  rendered: RenderedAgentPromptEnvelope,
  providerMessages: readonly AgentModelMessage[],
): InstructionInventory {
  return buildInstructionInventory({
    fixed: rendered.inventory.fixedPrompt,
    tools: rendered.inventory.tools,
    matchedSkills: rendered.inventory.matchedSkillInstructions,
    dynamicGuidance: rendered.inventory.dynamicGuidance,
    stableResource: rendered.inventory.stableResourceBlock,
    turnResource: rendered.inventory.turnResource,
    providerMessages,
  });
}

export async function buildAgentInitialMessages(
  request: AgentRuntimeRequest,
  tools: AgentToolDefinition<any, any>[],
  matchedSkillIds: ReadonlyArray<string>,
  resourceContextPlan?: AgentResourceContextPlan,
  options: {
    transcriptMessages?: AgentModelMessage[];
    contentInputs?: AgentContentInputCapabilities;
    onInstructionInventory?: (inventory: InstructionInventory) => void;
  } = {},
): Promise<AgentModelMessage[]> {
  const rendered = await renderAgentPromptEnvelope(
    request,
    tools,
    matchedSkillIds,
    resourceContextPlan,
    { contentInputs: options.contentInputs },
  );
  const transcriptMessages =
    options.transcriptMessages === undefined
      ? normalizeHistoryMessages(request)
      : options.transcriptMessages;
  const messages = composeAgentModelInput(rendered.envelope, {
    transcriptMessages,
  });
  if (options.onInstructionInventory) {
    options.onInstructionInventory(
      buildAgentPromptInstructionInventory(rendered, messages),
    );
  }
  return messages;
}
