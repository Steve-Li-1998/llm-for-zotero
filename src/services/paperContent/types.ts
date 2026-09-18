export type PdfContext = {
  title: string;
  chunks: string[];
  chunkMeta: PdfChunkMeta[];
  chunkStats: ChunkStat[];
  docFreq: Record<string, number>;
  avgChunkLength: number;
  fullLength: number;
  embeddings?: number[][];
  embeddingCacheKey?: string;
  embeddingPromise?: Promise<number[][] | null>;
  embeddingPromiseKey?: string;
  embeddingFailureKey?: string;
  sourceType?:
    | "mineru"
    | "zotero-worker"
    | "zotero-fulltext-cache"
    | "attachment-markdown"
    | "attachment-html"
    | "attachment-txt"
    | "attachment-docx";
};

export type PdfChunkKind =
  | "abstract"
  | "introduction"
  | "methods"
  | "results"
  | "discussion"
  | "conclusion"
  | "references"
  | "figure-caption"
  | "table-caption"
  | "appendix"
  | "body"
  | "unknown";

export type DocumentReferenceConfidence = "high" | "medium" | "low";

export type DocumentReferenceEvidence = {
  kind: "figure" | "table";
  id: string;
  panel?: string;
  confidence: DocumentReferenceConfidence;
  provenance: string[];
  pageStart?: number;
  pageEnd?: number;
};

export type PdfChunkMeta = {
  chunkIndex: number;
  text: string;
  normalizedText: string;
  sectionLabel?: string;
  /** Position of the enclosing section in the manifest's section list. */
  sectionIndex?: number;
  /** Heading chain down to the chunk, e.g. `2 Algorithm › 2.1 Weak form`. */
  sectionPath?: string;
  /** Markdown heading depth of the enclosing section: `#` → 1, `##` → 2. */
  sectionLevel?: number;
  chunkKind: PdfChunkKind;
  /**
   * Where {@link chunkKind} came from: `manifest` when the section heading
   * names a standard section, `heuristic` when the chunk text decided it.
   */
  kindSource?: "manifest" | "heuristic";
  anchorText?: string;
  leadingNoiseRemoved?: boolean;
  sourceType?: PdfContext["sourceType"];
  sourceStart?: number;
  sourceEnd?: number;
  sourceFingerprint?: string;
  pageStart?: number;
  pageEnd?: number;
  references?: DocumentReferenceEvidence[];
};

/** Structure rule that put a candidate in the final set. */
export type RetrievalStructureRule =
  | "heading_match"
  | "section_cap"
  | "neighbour"
  | "section_diverse_fallback";

/**
 * Why a chunk is in the retrieved set, in the terms the ranker used: its two
 * input ranks, the bounded section prior applied to them, and the structure
 * rule that reserved or back-filled its slot.
 */
export type RetrievalExplanation = {
  /** 1-based BM25 rank over the whole document. */
  bm25Rank: number;
  /** 1-based embedding rank, absent when embeddings did not run. */
  embeddingRank?: number;
  /**
   * Rank shift applied to the fused rank: `-2` for a boosted section kind,
   * `0` for neutral kinds, `Number.POSITIVE_INFINITY` for demoted chunks
   * (references, captions, appendix, short chunks, citation lists). JSON
   * consumers see `null` for the infinite case.
   */
  priorShift: number;
  structureRule?: RetrievalStructureRule;
  kindSource?: "manifest" | "heuristic";
};

export type PaperContextCandidate = {
  paperKey: string;
  itemId: number;
  contextItemId: number;
  title: string;
  citationKey?: string;
  firstCreator?: string;
  year?: string;
  chunkIndex: number;
  chunkText: string;
  sectionLabel?: string;
  /** Position of the enclosing section in the document's section list. */
  sectionIndex?: number;
  /** Heading chain down to the chunk, e.g. `2 Algorithm › 2.1 Weak form`. */
  sectionPath?: string;
  chunkKind?: PdfChunkKind;
  anchorText?: string;
  leadingNoiseRemoved?: boolean;
  sourceStart?: number;
  sourceEnd?: number;
  sourceFingerprint?: string;
  pageStart?: number;
  pageEnd?: number;
  estimatedTokens: number;
  bm25Score: number;
  embeddingScore: number;
  hybridScore: number;
  evidenceScore: number;
  matchedQueryVariant?: string;
  matchedQueryVariants?: string[];
  referenceConfidence?: DocumentReferenceConfidence;
  /** Ranking explanation; set by `buildPaperRetrievalCandidates`. */
  why?: RetrievalExplanation;
};

export type ChunkStat = {
  index: number;
  length: number;
  tf: Record<string, number>;
  uniqueTerms: string[];
};
