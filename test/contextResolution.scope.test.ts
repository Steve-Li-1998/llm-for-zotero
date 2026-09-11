import { assert } from "chai";
import { createCodexGlobalPortalItem } from "../src/codexAppServer/portal";
import { resolveContextSourceItem } from "../src/modules/contextPanel/contextResolution";
import {
  getActiveReaderForSelectedTab,
  getLastKnownSelectedTabId,
  refreshLastKnownSelectedTabId,
} from "../src/services/pdf/zoteroReaderTabs";

describe("context resolution scope boundaries", function () {
  const globalScope = globalThis as any;
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  it("does not resolve active reader context for Codex library chat portals", function () {
    const activeReaderAttachment = {
      id: 2000000001,
      parentID: 77,
      attachmentContentType: "application/pdf",
      attachmentFilename: "active.pdf",
      isAttachment: () => true,
      getField: (field: string) => (field === "title" ? "Active PDF" : ""),
    };
    globalScope.Zotero = {
      Items: {
        get: (id: number) =>
          id === activeReaderAttachment.id ? activeReaderAttachment : null,
      },
      Tabs: {
        selectedID: "reader-1",
        selectedType: "reader",
        _tabs: [
          {
            id: "reader-1",
            type: "reader",
            data: { itemID: activeReaderAttachment.id },
          },
        ],
      },
    };

    const resolved = resolveContextSourceItem(
      createCodexGlobalPortalItem(1, 700001) as Zotero.Item,
    );

    assert.equal(resolved.contextItem, null);
    assert.equal(resolved.sourceKind, "none");
  });

  it("refreshes the selected tab cache without resolving the reader", function () {
    let readerLookups = 0;
    globalScope.Zotero = {
      Tabs: {
        selectedID: "reader-cache-test",
        selectedType: "reader",
        _tabs: [],
      },
      Reader: {
        getByTabID: () => {
          readerLookups += 1;
          return { id: "reader-cache-test" };
        },
      },
    };

    assert.equal(refreshLastKnownSelectedTabId(), "reader-cache-test");
    assert.equal(getLastKnownSelectedTabId(), "reader-cache-test");
    assert.equal(readerLookups, 0);

    const reader = getActiveReaderForSelectedTab();

    assert.deepEqual(reader, { id: "reader-cache-test" });
    assert.equal(readerLookups, 1);
  });
});
