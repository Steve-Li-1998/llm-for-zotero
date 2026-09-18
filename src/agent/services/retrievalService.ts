import { buildPaperRetrievalCandidates } from "../../services/paperContent/pdfContext";
import type { RetrievalExplanation } from "../../services/paperContent/types";
import {
  buildRetrievalQueryPlanCacheKey,
  resolveRetrievalQueryPlan,
  type RetrievalQueryPlan,
} from "../../services/retrieval/retrievalQueryPlan";
import {
  callEmbeddings,
  resolveSemanticSearchState,
  type ChatParams,
} from "../../utils/llmClient";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../services/paperContent/paperAttribution";
import type { PaperContextRef } from "../../shared/types";
import { PdfService } from "./pdfService";
import type { ModelProfileOverride } from "../../modelCapabilities";

type RetrievalResult = {
  paperContext: PaperContextRef;
  chunkIndex: number;
  sectionLabel?: string;
  sectionPath?: string;
  chunkKind?: string;
  citationLabel: string;
  sourceLabel: string;
  text: string;
  score: number;
  sourceStart?: number;
  sourceEnd?: number;
  sourceFingerprint?: string;
  pageStart?: number;
  pageEnd?: number;
  /** Why this chunk was retrieved: input ranks, section prior, structure rule. */
  why?: RetrievalExplanation;
};

function dedupePaperContexts(
  paperContexts: PaperContextRef[],
): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of paperContexts) {
    if (
      !entry ||
      !Number.isFinite(entry.itemId) ||
      !Number.isFinite(entry.contextItemId)
    )
      continue;
    const key = `${entry.libraryID || 0}:${entry.itemId}:${entry.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

type EvidenceCacheKey = string;

function buildEvidenceCacheKey(
  contextItemId: number,
  queryKey: string,
  sectionIds?: string[],
): EvidenceCacheKey {
  // Strip punctuation and normalise whitespace so minor phrasing variations
  // (e.g. "What is the method?" vs "what is the method") share a cache entry.
  const normalizedQ = queryKey
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  // A section-restricted read is a different read: it must never be served
  // from the whole-document entry for the same question, or the other way
  // round.
  const sortedSectionIds = [...(sectionIds || [])].sort();
  const sectionKey = sortedSectionIds.length
    ? `::${sortedSectionIds.join(",")}`
    : "";
  return `${contextItemId}::${normalizedQ}${sectionKey}`;
}

export class RetrievalService {
  private readonly evidenceCache = new Map<
    EvidenceCacheKey,
    RetrievalResult[]
  >();

  constructor(
    private readonly pdfService: PdfService,
    private readonly candidateBuilder = buildPaperRetrievalCandidates,
  ) {}

  async retrieveEvidence(params: {
    papers: PaperContextRef[];
    question: string;
    queryVariants?: string[];
    queryPlan?: RetrievalQueryPlan;
    intent?: import("../types").ClassifiedTurnIntent;
    model?: string;
    apiBase?: string;
    apiKey?: string;
    authMode?: ChatParams["authMode"];
    providerProtocol?: ProviderProtocol;
    profileOverride?: ModelProfileOverride;
    signal?: AbortSignal;
    topK?: number;
    perPaperTopK?: number;
    /** Restrict candidates to these section ids (`s<n>`) before ranking. */
    sectionIds?: string[];
  }): Promise<RetrievalResult[]> {
    const papers = dedupePaperContexts(params.papers);
    if (!papers.length) return [];
    const perPaperTopK = Number.isFinite(params.perPaperTopK)
      ? Math.max(1, Math.floor(params.perPaperTopK as number))
      : 4;
    const topK = Number.isFinite(params.topK)
      ? Math.max(1, Math.floor(params.topK as number))
      : 6;
    const pdfContexts = new Map<
      number,
      Awaited<ReturnType<PdfService["ensurePaperContext"]>>
    >();
    for (const paperContext of papers) {
      pdfContexts.set(
        paperContext.contextItemId,
        await this.pdfService.ensurePaperContext(paperContext),
      );
    }
    const queryPlan = await resolveRetrievalQueryPlan({
      query: params.question,
      queryVariants: params.queryVariants,
      queryPlan: params.queryPlan,
      hasRetrievalContext: true,
      model: params.model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      authMode: params.authMode,
      providerProtocol: params.providerProtocol,
      profileOverride: params.profileOverride,
      signal: params.signal,
      sourceSamples: papers.map((paperContext) => {
        const pdfContext = pdfContexts.get(paperContext.contextItemId);
        return [paperContext.title, pdfContext?.chunks[0] || ""]
          .filter(Boolean)
          .join("\n");
      }),
    });
    queryPlan.retrievalPurpose = params.intent?.semantic?.retrievalPurpose;
    queryPlan.quoteAnchorPolicy =
      params.intent?.retrievalIntent === "verify" ? "verified" : "none";
    const queryCacheKey = buildRetrievalQueryPlanCacheKey(queryPlan);
    let embeddingsAvailable = false;
    try {
      // Honour an explicit "off": never spend a query-embedding call on a user
      // who turned semantic search off.
      embeddingsAvailable = resolveSemanticSearchState().enabled;
    } catch {
      embeddingsAvailable = false;
    }
    let precomputedQueryEmbedding: number[] | undefined;
    if (queryPlan.semanticQuery.trim() && embeddingsAvailable) {
      try {
        precomputedQueryEmbedding = (
          await callEmbeddings([queryPlan.semanticQuery])
        )[0];
      } catch {
        // Embedding unavailable — buildPaperRetrievalCandidates will fall back.
      }
    }
    const sectionIds = (params.sectionIds || []).filter(
      (sectionId) => typeof sectionId === "string" && sectionId.trim(),
    );
    const results: RetrievalResult[] = [];
    for (const paperContext of papers) {
      const cacheKey = buildEvidenceCacheKey(
        paperContext.contextItemId,
        queryCacheKey,
        sectionIds,
      );
      const cached = this.evidenceCache.get(cacheKey);
      if (cached) {
        results.push(...cached);
        continue;
      }
      const pdfContext = pdfContexts.get(paperContext.contextItemId);
      const candidates = await this.candidateBuilder(
        paperContext,
        pdfContext,
        params.question,
        {
          apiBase: params.apiBase,
          apiKey: params.apiKey,
          precomputedQueryEmbedding,
          queryPlan,
          ...(sectionIds.length ? { sectionIds } : {}),
        },
        {
          topK: perPaperTopK,
          mode: "evidence",
          precomputedQueryEmbedding,
          queryPlan,
          ...(sectionIds.length ? { sectionIds } : {}),
        },
      );
      const paperResults: RetrievalResult[] = candidates.map((candidate) => ({
        paperContext,
        chunkIndex: candidate.chunkIndex,
        sectionLabel: candidate.sectionLabel,
        sectionPath: candidate.sectionPath,
        chunkKind: candidate.chunkKind,
        citationLabel: formatPaperCitationLabel(paperContext),
        sourceLabel: formatPaperSourceLabel(paperContext),
        text: candidate.chunkText,
        score: candidate.evidenceScore,
        sourceStart: candidate.sourceStart,
        sourceEnd: candidate.sourceEnd,
        sourceFingerprint: candidate.sourceFingerprint,
        pageStart: candidate.pageStart,
        pageEnd: candidate.pageEnd,
        why: candidate.why,
      }));
      this.evidenceCache.set(cacheKey, paperResults);
      results.push(...paperResults);
    }
    results.sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex);
    return results.slice(0, topK);
  }

  clearEvidenceCache(): void {
    this.evidenceCache.clear();
  }
}
