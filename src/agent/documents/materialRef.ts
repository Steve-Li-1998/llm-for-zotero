/**
 * Identity of one finalized material revision.
 *
 * It lives in its own leaf module because every layer that names material —
 * documents, the action contract, the runtime, checkpoints — must use this one
 * identity, and none of them may depend on the rest of the document types to
 * do so.
 */
export type MaterialRef = Readonly<{
  documentId: string;
  documentVersion: number;
  contentHash: string;
}>;
