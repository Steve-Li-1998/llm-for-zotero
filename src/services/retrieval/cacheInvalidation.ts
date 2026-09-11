export type RetrievalCandidateInvalidator = (contextItemId?: number) => void;

let activeInvalidator: RetrievalCandidateInvalidator | null = null;

export function configureRetrievalCandidateInvalidator(
  invalidator: RetrievalCandidateInvalidator,
): () => void {
  activeInvalidator = invalidator;
  return () => {
    if (activeInvalidator === invalidator) activeInvalidator = null;
  };
}

export function invalidateRetrievalCandidates(contextItemId?: number): void {
  activeInvalidator?.(contextItemId);
}
