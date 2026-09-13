import type { ActionCardResolvers } from "./actionCardModel";

/**
 * Read the library, and say nothing when it cannot be read.
 *
 * The card is drawn in contexts where Zotero is absent (tests, a window torn
 * down mid-render) and against ids the library may no longer hold. A resolver
 * that throws or finds nothing returns undefined, and the card falls back to
 * the identity the receipt carried rather than inventing a name.
 */
function readLibrary<T>(read: () => T | undefined): T | undefined {
  try {
    if (typeof Zotero === "undefined") return undefined;
    return read();
  } catch {
    return undefined;
  }
}

/** The year a citation reads by: the first one the item's date states. */
function citationYear(item: Zotero.Item): string | undefined {
  return /\b(19|20)\d{2}\b/.exec(item.getField("date") || "")?.[0];
}

/**
 * How the panel names a native object the receipts touched.
 *
 * An item is named the way the reader already sees it cited — creator and
 * year — and falls back to its creator alone, then to its title, because a
 * paper with no date is still a paper the reader recognizes.
 */
export function createZoteroActionCardResolvers(
  materialTitle: (documentId: string) => string | undefined,
): ActionCardResolvers {
  return {
    itemLabel: (itemId) =>
      readLibrary(() => {
        const item = Zotero.Items.get(itemId);
        if (!item) return undefined;
        const creator = item.firstCreator;
        const year = citationYear(item);
        const label =
          creator && year
            ? `${creator}, ${year}`
            : creator || item.getDisplayTitle();
        return label
          ? { label, libraryID: item.libraryID, itemKey: item.key }
          : undefined;
      }),
    collectionLabel: (collectionId) =>
      readLibrary(() => {
        const collection = Zotero.Collections.get(
          collectionId,
        ) as Zotero.Collection | null;
        return collection?.name
          ? { label: collection.name, libraryID: collection.libraryID }
          : undefined;
      }),
    noteLabel: (noteId) =>
      readLibrary(() => {
        const note = Zotero.Items.get(noteId);
        if (!note) return undefined;
        return {
          label: note.getNoteTitle() || "Note",
          libraryID: note.libraryID,
          itemKey: note.key,
        };
      }),
    materialTitle,
  };
}
