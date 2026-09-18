/**
 * The warning channel every conversation store writes to.
 *
 * The stores run inside Zotero, where `Zotero.debug` is the only log sink that
 * survives to the debug output pane, and they also run inside tests and
 * migrations where no `Zotero` global exists at all.  Reaching for the global
 * lazily on each call — rather than capturing it at module load — is what keeps
 * the same function usable in both places.
 */
export function logConversationStoreWarning(message: string): void {
  const debug = (
    globalThis as typeof globalThis & {
      Zotero?: { debug?: (message: string) => void };
    }
  ).Zotero?.debug;
  debug?.(`LLM: ${message}`);
}

/** Render a thrown value for a store warning without losing a non-Error. */
export function formatConversationStoreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
