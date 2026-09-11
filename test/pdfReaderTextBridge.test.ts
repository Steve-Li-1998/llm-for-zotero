import { assert } from "chai";
import {
  configurePdfReaderTextBridge,
  verifyCompleteQuoteInLivePdf,
  warmPdfPageTextCache,
  warmPdfPageTextCacheForAttachment,
} from "../src/services/pdf/readerTextBridge";

describe("PDF reader text bridge", function () {
  it("routes runtime requests through the configured reader adapter", async function () {
    const calls: string[] = [];
    const reset = configurePdfReaderTextBridge({
      warmPageTextCache: async () => {
        calls.push("reader");
        return {
          pages: [{ pageIndex: 0, text: "page text" }],
          normalised: [],
          coverage: "full-viewer",
        };
      },
      warmPageTextCacheForAttachment: async (itemId) => {
        calls.push(`attachment:${itemId}`);
        return null;
      },
      verifyCompleteQuote: async (_reader, itemId, quote) => {
        calls.push(`quote:${itemId}:${quote}`);
        return { status: "literal-not-found", documentFingerprint: "pdf-1" };
      },
    });

    try {
      const cache = await warmPdfPageTextCache({});
      assert.equal(cache?.pages[0]?.text, "page text");
      assert.isNull(await warmPdfPageTextCacheForAttachment(42));
      assert.deepEqual(await verifyCompleteQuoteInLivePdf({}, 42, "claim"), {
        status: "literal-not-found",
        documentFingerprint: "pdf-1",
      });
      assert.deepEqual(calls, ["reader", "attachment:42", "quote:42:claim"]);
    } finally {
      reset();
    }
  });

  it("fails explicitly when UI reader capabilities were not composed", async function () {
    const restore = configurePdfReaderTextBridge(null);
    try {
      let error: unknown;
      try {
        await warmPdfPageTextCache({});
      } catch (caught) {
        error = caught;
      }
      assert.match(String(error), /reader text adapter is not configured/i);
    } finally {
      restore();
    }
  });
});
