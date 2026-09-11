export type PdfReaderPageText = {
  pageIndex: number;
  pageLabel?: string;
  text: string;
};

export type PdfReaderTextCache = {
  pages: PdfReaderPageText[];
  normalised: Array<{
    pageIndex: number;
    pageLabel?: string;
    normalizedText: string;
    textIndex: unknown;
  }>;
  coverage: "full-pdfworker" | "full-viewer" | "partial-dom";
  pageCount?: number;
  sourceFingerprint?: string;
};

export type PdfQuoteCertificate = {
  contextItemId: number;
  documentFingerprint: string;
  pageIndex: number;
  pageLabel?: string;
  sourceMatchText: string;
  sourceMatchKind: "exact" | "normalized-span";
  sourceMatchPageOccurrence: number;
};

export type PdfQuoteVerification =
  | { status: "matched"; certificate: PdfQuoteCertificate }
  | { status: "literal-not-found"; documentFingerprint: string }
  | { status: "defer"; reason: string };

export type PdfReaderTextAdapter = {
  warmPageTextCache: (reader: any) => Promise<PdfReaderTextCache | null>;
  warmPageTextCacheForAttachment: (
    contextItemId: number,
    options?: {
      yieldToMain?: () => Promise<void>;
      shouldContinue?: () => boolean;
      reader?: any;
    },
  ) => Promise<PdfReaderTextCache | null>;
  verifyCompleteQuote: (
    reader: any,
    contextItemId: number,
    quoteText: string,
    options?: {
      yieldToMain?: () => Promise<void>;
      shouldContinue?: () => boolean;
      allowInlineMathLocator?: boolean;
    },
  ) => Promise<PdfQuoteVerification>;
};

let activeAdapter: PdfReaderTextAdapter | null = null;

export function configurePdfReaderTextBridge(
  adapter: PdfReaderTextAdapter | null,
): () => void {
  const previous = activeAdapter;
  activeAdapter = adapter;
  return () => {
    if (activeAdapter === adapter) activeAdapter = previous;
  };
}

function requireAdapter(): PdfReaderTextAdapter {
  if (!activeAdapter) {
    throw new Error(
      "The Zotero PDF reader text adapter is not configured for this application surface.",
    );
  }
  return activeAdapter;
}

export function warmPdfPageTextCache(
  reader: any,
): Promise<PdfReaderTextCache | null> {
  return requireAdapter().warmPageTextCache(reader);
}

export function warmPdfPageTextCacheForAttachment(
  contextItemId: number,
  options?: Parameters<
    PdfReaderTextAdapter["warmPageTextCacheForAttachment"]
  >[1],
): Promise<PdfReaderTextCache | null> {
  return requireAdapter().warmPageTextCacheForAttachment(
    contextItemId,
    options,
  );
}

export function verifyCompleteQuoteInLivePdf(
  reader: any,
  contextItemId: number,
  quoteText: string,
  options?: Parameters<PdfReaderTextAdapter["verifyCompleteQuote"]>[3],
): Promise<PdfQuoteVerification> {
  return requireAdapter().verifyCompleteQuote(
    reader,
    contextItemId,
    quoteText,
    options,
  );
}
