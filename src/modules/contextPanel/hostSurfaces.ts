/**
 * Composition root for the capabilities the Zotero panel provides to services
 * and agent code through `src/services/**` bridges.
 *
 * This is the only place that knows both halves of each bridge. It runs once
 * from plugin startup — never as a side effect of importing a UI module — so
 * that whether a capability is available depends on the plugin being started,
 * not on which module some code path happened to import first.
 */
import { configureContextSelectionBridge } from "../../services/context/contextSelectionBridge";
import { configureAssistantNoteWriter } from "../../services/notes/assistantNoteWriterBridge";
import { configurePdfReaderTextBridge } from "../../services/pdf/readerTextBridge";
import { configureRetrievalCandidateInvalidator } from "../../services/retrieval/cacheInvalidation";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
} from "./contextResolution";
import {
  verifyCompleteQuoteInLivePdfJs,
  warmPageTextCache,
  warmPageTextCacheForAttachment,
} from "./livePdfSelectionLocator";
import { refreshChat } from "./chat";
import { clearRetrievalCandidateCache } from "./multiContextPlanner";
import { configureQuoteValidationChatRefresher } from "./quoteValidation/chatRefreshBridge";
import {
  createNoteFromAssistantText,
  createStandaloneNoteFromAssistantText,
} from "./notes";

/**
 * Configures every host surface bridge and returns a disposer that undoes the
 * whole composition, in reverse order, on plugin shutdown.
 */
export function composeHostSurfaces(): () => void {
  const disposers = [
    configurePdfReaderTextBridge({
      warmPageTextCache,
      warmPageTextCacheForAttachment,
      verifyCompleteQuote: verifyCompleteQuoteInLivePdfJs,
    }),
    configureContextSelectionBridge({
      getActiveAttachment: getActiveContextAttachmentFromTabs,
      resolveContextItem: (item) => resolveContextSourceItem(item).contextItem,
    }),
    configureAssistantNoteWriter({
      writeItemNote: (params) =>
        createNoteFromAssistantText(
          params.item,
          params.content,
          params.modelName,
          undefined,
          {
            appendToTrackedNote: params.appendToTrackedNote,
            rememberCreatedNote: params.appendToTrackedNote,
            generatedImages: params.generatedImages,
          },
        ),
      writeStandaloneNote: async (params) => {
        const result = await createStandaloneNoteFromAssistantText(
          params.libraryID,
          params.content,
          params.modelName,
          undefined,
          undefined,
          params.generatedImages,
          undefined,
          undefined,
          params.collections,
        );
        return { ...result, status: "standalone_created" };
      },
    }),
    configureRetrievalCandidateInvalidator(clearRetrievalCandidateCache),
    // The background quote validator repaints the messages it changed; only
    // the chat renderer can do that, and it imports the validator, so the
    // dependency is composed here rather than registered at import time.
    configureQuoteValidationChatRefresher(refreshChat),
  ];
  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}
