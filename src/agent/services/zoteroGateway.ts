import {
  libraryIndexService,
  normalizeLibraryIndexText,
  type LibraryIndexItem,
  type LibraryIndexSnapshot,
} from "../../services/libraryIndexService";
import type { NoteImageImportInput } from "../../services/notes/noteImages";
import {
  getSelectedContextAttachment,
  resolveSelectedContextItem,
} from "../../services/context/contextSelectionBridge";
import { resolvePaperContextRefFromAttachment } from "../../services/paperContent/paperAttribution";
import type { AgentRuntimeRequest } from "../types";
import { getTurnPapers } from "../context/requestTurnPaperScope";
import type {
  GeneratedChatImage,
  PaperContextRef,
  TagContextRef,
} from "../../shared/types";
import type {
  BatchTagAssignment,
  EditableArticleCreator,
  EditableArticleMetadataField,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
} from "./libraryMutation/valueTypes";
export type {
  BatchTagAssignment,
  EditableArticleCreator,
  EditableArticleMetadataField,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
} from "./libraryMutation/valueTypes";
import {
  getCollection,
  getCollectionSummary,
} from "./zotero/internal/collections";
import {
  getItem,
  getItemTypeName,
  isFieldValidForItemType,
  listEditableFieldsForItem,
  resolveBibliographicItem,
  resolveMatrixItem,
  resolveRegularItem,
} from "./zotero/internal/itemResolution";
import {
  buildAgentLibrarySearch,
  indexItemMatchesAggregateTagScope,
  indexItemMatchesType,
  libraryItemTargetMatchesFilters,
  libraryItemTargetMatchesYear,
  orderedGatewayPaperIds,
  orderedIndexIds,
  pageIds,
  sortAndPageIndexIds,
  validateSearchConditions,
} from "./zotero/internal/libraryIndex";
import {
  AGENT_WRITABLE_PREFS,
  EDITABLE_ARTICLE_METADATA_FIELDS,
  NON_EDITABLE_METADATA_FIELDS,
  normalizeCreatorForSnapshot,
} from "./zotero/internal/metadataTables";
import {
  normalizeMetadataValue,
  normalizePaperContexts,
  normalizeResultLimit,
  normalizeText,
} from "./zotero/internal/normalize";
import {
  buildItemTargetFromItem,
  buildItemTargetsForIds,
  buildPaperTargetFromItem,
  buildPaperTargetsForIds,
} from "./zotero/internal/targetBuilders";
import type {
  AgentLibraryFilters,
  AgentSearchCondition,
  CollectionSummary,
  LibraryItemTarget,
  LibraryItemTargetAttachment,
  LibraryPaperTarget,
} from "./zotero/internal/types";
import { AttachmentCapability } from "./zotero/attachmentCapability";
import {
  CollectionCapability,
  type BatchMoveAssignment,
  type BatchMoveItemResult,
  type CollectionBrowseNode,
  type ItemCollectionSet,
} from "./zotero/collectionCapability";
import { ImportCapability } from "./zotero/importCapability";
import {
  NoteCapability,
  type PaperAnnotationRecord,
  type PaperNoteRecord,
  type SaveAnswerToNoteResult,
} from "./zotero/noteCapability";
import { TagCapability, type BatchTagItemResult } from "./zotero/tagCapability";

/**
 * The shared substrate every capability needs, re-exported under the names
 * callers already use.
 *
 * `src/agent/services/zotero/` is the gateway's internals: the architecture
 * check refuses an import into it from anywhere but this file, so this is the
 * one place the names cross the boundary.
 */
export type {
  AgentLibraryFilters,
  AgentSearchCondition,
  AgentSearchConditionError,
  CollectionSummary,
  LibraryItemTarget,
  LibraryItemTargetAttachment,
  LibraryPaperTarget,
  LibraryPaperTargetAttachment,
} from "./zotero/internal/types";
export { listEditableFieldsForItem } from "./zotero/internal/itemResolution";
export { validateSearchConditions } from "./zotero/internal/libraryIndex";
export { EDITABLE_ARTICLE_METADATA_FIELDS } from "./zotero/internal/metadataTables";
export type {
  PaperAnnotationRecord,
  PaperNoteRecord,
  SaveAnswerToNoteResult,
} from "./zotero/noteCapability";
export type { BatchTagItemResult } from "./zotero/tagCapability";
export type {
  BatchMoveAssignment,
  BatchMoveItemResult,
  CollectionBrowseNode,
  ItemCollectionSet,
} from "./zotero/collectionCapability";

export type RelatedPaperResult = LibraryPaperTarget & {
  matchScore: number;
  matchReasons: string[];
};

export type DuplicateGroup = {
  matchReason: string;
  papers: LibraryPaperTarget[];
};

export class ZoteroGateway {
  /**
   * The import paths, split out of this file.
   *
   * The dependencies are thunks rather than bound methods so the lookup they
   * reach is resolved per call: a caller (and every test in
   * `importTranslateAndIdentifiers.test.ts`) that replaces `getItem` or
   * `getCollection` on a gateway instance still steers the import paths.
   */
  private readonly importCapability = new ImportCapability({
    getItem: (itemId) => this.getItem(itemId),
    getCollection: (collectionId) => this.getCollection(collectionId),
    getEditableArticleMetadata: (item) => this.getEditableArticleMetadata(item),
  });

  /**
   * The note paths, split out of this file. Same thunk wiring as the import
   * capability, for the same reason.
   */
  private readonly noteCapability = new NoteCapability({
    getItem: (itemId) => this.getItem(itemId),
    resolveBibliographicItem: (item) => this.resolveBibliographicItem(item),
  });

  /**
   * The attachment paths, split out of this file. Same thunk wiring as the
   * import capability, for the same reason.
   */
  private readonly attachmentCapability = new AttachmentCapability({
    getItem: (itemId) => this.getItem(itemId),
    resolveBibliographicItem: (item) => this.resolveBibliographicItem(item),
  });

  /**
   * The tag paths, split out of this file. Same thunk wiring as the import
   * capability, for the same reason.
   */
  private readonly tagCapability = new TagCapability({
    getItem: (itemId) => this.getItem(itemId),
    resolveBibliographicItem: (item) => this.resolveBibliographicItem(item),
  });

  /**
   * The collection and saved-search paths, split out of this file. Same thunk
   * wiring as the import capability, for the same reason — and here the
   * reason is load-bearing: `collectionMoveSemantics.test.ts` replaces both
   * `getItem` and `getCollectionSummary` on a gateway instance.
   */
  private readonly collectionCapability = new CollectionCapability({
    getItem: (itemId) => this.getItem(itemId),
    getCollection: (collectionId) => this.getCollection(collectionId),
    getCollectionSummary: (collectionId) =>
      this.getCollectionSummary(collectionId),
    resolveBibliographicItem: (item) => this.resolveBibliographicItem(item),
  });

  getItemByLibraryAndKey(libraryID: number, key: string): Zotero.Item | null {
    return Zotero.Items.getByLibraryAndKey(libraryID, key) || null;
  }

  getItem(itemId: number | undefined): Zotero.Item | null {
    return getItem(itemId);
  }

  getCollection(collectionId: number | undefined): Zotero.Collection | null {
    return getCollection(collectionId);
  }

  resolveLibraryID(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    libraryID?: number;
  }): number {
    const explicitLibraryID = Number(params.libraryID);
    if (Number.isFinite(explicitLibraryID) && explicitLibraryID > 0) {
      return Math.floor(explicitLibraryID);
    }
    const itemLibraryID = Number(params.item?.libraryID);
    if (Number.isFinite(itemLibraryID) && itemLibraryID > 0) {
      return Math.floor(itemLibraryID);
    }
    const requestLibraryID = Number(params.request?.libraryID);
    if (Number.isFinite(requestLibraryID) && requestLibraryID > 0) {
      return Math.floor(requestLibraryID);
    }
    const activeItemLibraryID = Number(
      this.getItem(params.request?.activeItemId)?.libraryID,
    );
    if (Number.isFinite(activeItemLibraryID) && activeItemLibraryID > 0) {
      return Math.floor(activeItemLibraryID);
    }
    return 0;
  }

  invalidateLibrarySearchCache(libraryID?: number): void {
    libraryIndexService.invalidate(libraryID);
  }

  getCollectionSummary(
    collectionId: number | undefined,
  ): CollectionSummary | null {
    return getCollectionSummary(collectionId);
  }

  /** See `CollectionCapability.getCollectionNativeState`. */
  getCollectionNativeState(collectionId: number): {
    exists: boolean;
    name: string;
    parentCollectionId: number | null;
    deleted: boolean;
  } {
    return this.collectionCapability.getCollectionNativeState(collectionId);
  }

  /** See `CollectionCapability.listCollectionSummaries`. */
  listCollectionSummaries(libraryID: number): CollectionSummary[] {
    return this.collectionCapability.listCollectionSummaries(libraryID);
  }

  /** See `CollectionCapability.listCurrentCollectionSummaries`. */
  listCurrentCollectionSummaries(libraryID: number): CollectionSummary[] {
    return this.collectionCapability.listCurrentCollectionSummaries(libraryID);
  }

  /** See `CollectionCapability.listCurrentCollectionTargetIds`. */
  listCurrentCollectionTargetIds(params: {
    libraryID: number;
    collectionId: number;
    targetKind: "papers" | "items";
  }): number[] {
    return this.collectionCapability.listCurrentCollectionTargetIds(params);
  }

  /** See `CollectionCapability.listCurrentLibraryTargetIds`. */
  async listCurrentLibraryTargetIds(params: {
    libraryID: number;
    targetKind: "papers" | "items";
  }): Promise<number[]> {
    return this.collectionCapability.listCurrentLibraryTargetIds(params);
  }

  /** See `AttachmentCapability.getAllChildAttachmentInfos`. */
  async getAllChildAttachmentInfos(
    itemId: number,
  ): Promise<LibraryItemTargetAttachment[]> {
    return this.attachmentCapability.getAllChildAttachmentInfos(itemId);
  }

  async listLibraryPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error("No active library available for listing papers");
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedGatewayPaperIds(snapshot);
    return {
      // Page IDs first. Only the returned page is enriched from live Zotero
      // objects; broad warm listing stays proportional to the page size.
      papers: buildPaperTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  getPaperTargetsByItemIds(itemIds: number[]): LibraryPaperTarget[] {
    const out: LibraryPaperTarget[] = [];
    const seen = new Set<number>();
    for (const rawItemId of itemIds) {
      const item = this.resolveBibliographicItem(this.getItem(rawItemId));
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      const target = buildPaperTargetFromItem(item);
      if (target) {
        out.push(target);
      }
    }
    return out;
  }

  resolvePaperContextTarget(params: {
    itemId?: number;
    contextItemId?: number;
  }): PaperContextRef | null {
    const itemId =
      Number.isFinite(params.itemId) && Number(params.itemId) > 0
        ? Math.floor(Number(params.itemId))
        : undefined;
    const contextItemId =
      Number.isFinite(params.contextItemId) && Number(params.contextItemId) > 0
        ? Math.floor(Number(params.contextItemId))
        : undefined;

    if (contextItemId) {
      const paperContext = resolvePaperContextRefFromAttachment(
        this.getItem(contextItemId),
      );
      if (!paperContext) return null;
      if (itemId && paperContext.itemId !== itemId) return null;
      return paperContext;
    }

    if (!itemId) return null;
    const item = this.resolveBibliographicItem(this.getItem(itemId));
    if (!item) return null;
    const target = buildPaperTargetFromItem(item);
    const firstAttachment = target?.attachments[0];
    if (!target || !firstAttachment) return null;
    return (
      resolvePaperContextRefFromAttachment(
        this.getItem(firstAttachment.contextItemId),
      ) || {
        itemId: target.itemId,
        contextItemId: firstAttachment.contextItemId,
        title: target.title,
        attachmentTitle: firstAttachment.title,
        firstCreator: target.firstCreator,
        year: target.year,
      }
    );
  }

  async listBibliographicItemTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    items: LibraryItemTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error(
        "No active library available for listing bibliographic items",
      );
    }
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedIndexIds(snapshot, (item) => item.kind === "regular");
    return {
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)).filter(
        (target) => !target.noteKind,
      ),
      totalCount: ids.length,
    };
  }

  getBibliographicItemTargetsByItemIds(itemIds: number[]): LibraryItemTarget[] {
    const out: LibraryItemTarget[] = [];
    const seen = new Set<number>();
    for (const rawItemId of itemIds) {
      const item = this.resolveBibliographicItem(this.getItem(rawItemId));
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      const target = buildItemTargetFromItem(item);
      if (target && !target.noteKind) {
        out.push(target);
      }
    }
    return out;
  }

  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null {
    return resolveBibliographicItem(item);
  }

  resolveMetadataItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    itemId?: number;
    paperContext?: PaperContextRef | null;
  }): Zotero.Item | null {
    const byItemId = resolveRegularItem(this.getItem(params.itemId));
    if (byItemId) return byItemId;
    const byPaperContext = resolveRegularItem(
      this.getItem(params.paperContext?.itemId),
    );
    if (byPaperContext) return byPaperContext;
    const byActiveItem = resolveRegularItem(
      this.getItem(params.request?.activeItemId),
    );
    if (byActiveItem) return byActiveItem;
    return resolveRegularItem(params.item || null);
  }

  getActiveContextItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null {
    if (item) {
      return resolveSelectedContextItem(item);
    }
    return getSelectedContextAttachment();
  }

  getActivePaperContext(
    item: Zotero.Item | null | undefined,
  ): PaperContextRef | null {
    return resolvePaperContextRefFromAttachment(
      this.getActiveContextItem(item),
    );
  }

  /** The note an edit applies to. See `NoteCapability.resolveActiveNoteItem`. */
  resolveActiveNoteItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    noteId?: number;
  }): Zotero.Item | null {
    return this.noteCapability.resolveActiveNoteItem(params);
  }

  /** See `NoteCapability.getActiveNoteSnapshot`. */
  getActiveNoteSnapshot(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    noteId?: number;
  }) {
    return this.noteCapability.getActiveNoteSnapshot(params);
  }

  /** See `NoteCapability.replaceCurrentNote`. */
  async replaceCurrentNote(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    noteId?: number;
    content: string;
    expectedOriginalHtml?: string;
    /** Pre-patched HTML that bypasses the text→HTML conversion.  When
     *  provided, this HTML is set directly on the note, preserving
     *  images, list numbering, and other structure that the plain-text
     *  roundtrip would destroy. */
    preRenderedHtml?: string;
  }): Promise<{
    noteId: number;
    title: string;
    previousHtml: string;
    previousText: string;
    nextText: string;
  }> {
    return this.noteCapability.replaceCurrentNote(params);
  }

  /** See `NoteCapability.restoreNoteHtml`. */
  async restoreNoteHtml(params: {
    noteId: number;
    html: string;
  }): Promise<void> {
    return this.noteCapability.restoreNoteHtml(params);
  }

  getEditableArticleMetadata(
    item: Zotero.Item | null | undefined,
  ): EditableArticleMetadataSnapshot | null {
    // Matches the write path: resolveRegularItem redirects a child
    // attachment to its parent, so reading back after writing on an
    // attachment returned the parent's fields and confirmed a change that
    // never happened to the object the user named.
    const resolution = resolveMatrixItem(item, Number(item?.id) || 0, "update");
    if ("refusal" in resolution) return null;
    const target = resolution.item;
    // Every field this item type actually has, not the fixed 18. The union
    // keeps the well-known names present (as empty strings) so existing card
    // layouts and callers still find them.
    const typeFields = listEditableFieldsForItem(target);
    const fieldNames = Array.from(
      new Set<string>([
        ...(EDITABLE_ARTICLE_METADATA_FIELDS as readonly string[]),
        ...typeFields,
      ]),
    );
    const fields = Object.fromEntries(
      fieldNames.map((fieldName) => {
        let value = "";
        try {
          // includeBaseMapped: `publicationTitle` is stored as `bookTitle` on
          // a book section and `proceedingsTitle` on a conference paper, so
          // without this it reads back empty on nine item types.
          value = normalizeMetadataValue(
            (
              target as unknown as {
                getField: (
                  name: string,
                  unformatted?: boolean,
                  includeBaseMapped?: boolean,
                ) => string;
              }
            ).getField(fieldName, false, true),
          );
        } catch (_error) {
          void _error;
        }
        return [fieldName, value];
      }),
    ) as Record<EditableArticleMetadataField, string>;
    let creators: EditableArticleCreator[] = [];
    try {
      creators = (target.getCreatorsJSON?.() || [])
        .map((creator) => normalizeCreatorForSnapshot(creator))
        .filter((creator): creator is EditableArticleCreator =>
          Boolean(creator),
        );
    } catch (_error) {
      void _error;
    }
    return {
      itemId: target.id,
      itemType: getItemTypeName(target),
      title:
        normalizeMetadataValue(target.getDisplayTitle?.()) ||
        fields.title ||
        `Item ${target.id}`,
      fields,
      creators,
    };
  }

  isEditableArticleMetadataFieldSupported(
    item: Zotero.Item | null | undefined,
    fieldName: EditableArticleMetadataField,
  ): boolean {
    const target = resolveRegularItem(item);
    if (!target) return false;
    return isFieldValidForItemType(target, fieldName);
  }

  supportsEditableArticleCreators(
    item: Zotero.Item | null | undefined,
  ): boolean {
    const target = resolveRegularItem(item);
    if (!target) return false;
    try {
      const creatorTypes = (
        Zotero as unknown as {
          CreatorTypes?: {
            itemTypeHasCreators?: (itemTypeId: number) => boolean;
          };
        }
      ).CreatorTypes;
      return typeof creatorTypes?.itemTypeHasCreators === "function"
        ? creatorTypes.itemTypeHasCreators(target.itemTypeID)
        : true;
    } catch (_error) {
      void _error;
      return true;
    }
  }

  listPaperContexts(request: AgentRuntimeRequest): PaperContextRef[] {
    return normalizePaperContexts([...getTurnPapers(request)]);
  }

  /** See `CollectionCapability.browseCollections`. */
  async browseCollections(params: { libraryID: number }): Promise<{
    libraryID: number;
    libraryName: string;
    collections: CollectionBrowseNode[];
    unfiled: {
      name: string;
      paperCount: number;
    };
  }> {
    return this.collectionCapability.browseCollections(params);
  }

  /** See `CollectionCapability.listCollectionPaperTargets`. */
  async listCollectionPaperTargets(params: {
    libraryID: number;
    collectionId: number;
    limit?: number;
  }): Promise<{
    collection: CollectionSummary;
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    return this.collectionCapability.listCollectionPaperTargets(params);
  }

  /** See `CollectionCapability.listUnfiledPaperTargets`. */
  async listUnfiledPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    return this.collectionCapability.listUnfiledPaperTargets(params);
  }

  /** See `TagCapability.listUntaggedPaperTargets`. */
  async listUntaggedPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    return this.tagCapability.listUntaggedPaperTargets(params);
  }

  // ── Universal item listing (all item types, not PDF-only) ──────────────────

  async listLibraryItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID)
      throw new Error("No active library available for listing items");
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedIndexIds(snapshot, (item) =>
      indexItemMatchesType(item, params.itemType),
    );
    return {
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  async listCollectionItemTargets(params: {
    libraryID: number;
    collectionId: number;
    limit?: number;
    itemType?: string;
  }): Promise<{
    collection: CollectionSummary;
    items: LibraryItemTarget[];
    totalCount: number;
  }> {
    const collection = this.getCollectionSummary(params.collectionId);
    if (!collection) throw new Error("Collection not found");
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const members =
      snapshot.directItemIdsByCollectionId.get(params.collectionId) ||
      new Set<number>();
    const ids = orderedIndexIds(
      snapshot,
      (item) =>
        members.has(item.itemId) && indexItemMatchesType(item, params.itemType),
    );
    return {
      collection,
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  async listUnfiledItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedIndexIds(
      snapshot,
      (item) =>
        snapshot.unfiledItemIds.has(item.itemId) &&
        indexItemMatchesType(item, params.itemType),
    );
    return {
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  async listUntaggedItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const ids = orderedIndexIds(
      snapshot,
      (item) =>
        snapshot.untaggedItemIds.has(item.itemId) &&
        indexItemMatchesType(item, params.itemType),
    );
    return {
      items: buildItemTargetsForIds(this, pageIds(ids, params.limit)),
      totalCount: ids.length,
    };
  }

  /** See `TagCapability.listTagItemTargets`. */
  async listTagItemTargets(params: {
    libraryID: number;
    tagContext: TagContextRef;
    limit?: number;
    itemType?: string;
  }): Promise<{
    tagName: string;
    items: LibraryItemTarget[];
    totalCount: number;
  }> {
    return this.tagCapability.listTagItemTargets(params);
  }

  async resolveLibraryScopeItemIds(params: {
    libraryID: number;
    itemIds?: number[];
    collectionIds?: number[];
    tagContexts?: TagContextRef[];
  }): Promise<{
    itemIds: number[];
    tagItemIds: number[];
    collectionNames: string[];
    tagNames: string[];
    summedScopeCount: number;
  }> {
    const snapshot = await libraryIndexService.getSnapshot(params.libraryID);
    const union = new Set<number>();
    const tagItemIds = new Set<number>();
    let summedScopeCount = 0;
    const add = (ids: Iterable<number>): number => {
      let count = 0;
      for (const id of ids) {
        const item = snapshot.itemById.get(id);
        // Retrieval is bibliographic: standalone notes/files remain available
        // to library_search but are not paper resources.
        if (!item || item.kind !== "regular" || item.deleted) continue;
        union.add(id);
        count += 1;
      }
      return count;
    };
    add(params.itemIds || []);
    const collectionNames: string[] = [];
    for (const collectionId of params.collectionIds || []) {
      const collection = snapshot.collectionById.get(collectionId);
      if (!collection || collection.libraryID !== params.libraryID) continue;
      collectionNames.push(
        snapshot.collectionPathById.get(collectionId) || collection.name,
      );
      summedScopeCount += add(
        snapshot.directItemIdsByCollectionId.get(collectionId) || [],
      );
    }
    const tagNames: string[] = [];
    for (const tagContext of params.tagContexts || []) {
      let ids: Set<number>;
      if (tagContext.scope === "allTagged") {
        ids = new Set(
          snapshot.topLevelItemOrder.filter((itemId) => {
            const item = snapshot.itemById.get(itemId);
            return Boolean(
              item &&
              indexItemMatchesAggregateTagScope(
                item,
                "allTagged",
                tagContext.includeAutomatic === true,
              ),
            );
          }),
        );
      } else if (tagContext.scope === "untagged") {
        ids = new Set(
          snapshot.topLevelItemOrder.filter((itemId) => {
            const item = snapshot.itemById.get(itemId);
            return Boolean(
              item &&
              indexItemMatchesAggregateTagScope(
                item,
                "untagged",
                tagContext.includeAutomatic === true,
              ),
            );
          }),
        );
      } else {
        ids = libraryIndexService.tagItemIds(
          snapshot,
          tagContext.name || tagContext.normalizedName || "",
          tagContext.includeAutomatic === true,
        );
      }
      tagNames.push(tagContext.name);
      summedScopeCount += add(ids);
      for (const id of ids) {
        if (snapshot.itemById.get(id)?.kind === "regular") tagItemIds.add(id);
      }
    }
    return {
      itemIds: [...union],
      tagItemIds: [...tagItemIds].filter((id) => union.has(id)),
      collectionNames,
      tagNames,
      summedScopeCount,
    };
  }

  /**
   * Runs an advanced search expressed in Zotero's own condition vocabulary.
   *
   * The nine hand-written filters could express a fraction of what the
   * Advanced Search window can. Rather than growing them one at a time, this
   * forwards conditions straight to `Zotero.Search`, so the agent inherits
   * every condition Zotero has — including ones added in future versions.
   *
   * Three things this must get right:
   *
   * - **Page before enriching.** The existing paths enrich every match and
   *   then slice, so a condition matching 20k items built 20k objects to show
   *   50. Here the id array is windowed first.
   * - **Resolve to parents.** `Zotero.Search` returns child items, and
   *   list-style callers drop anything with a `parentID` — so `fulltextContent`,
   *   `annotationText` and `childNote` would match and then vanish.
   * - **Never omit the library.** A `Zotero.Search` with no `libraryID`
   *   searches *every* library, including group libraries the user did not ask
   *   about.
   */
  async searchItemsByConditions(params: {
    libraryID: number;
    conditions: AgentSearchCondition[];
    joinMode?: "all" | "any";
    resolveToParents?: boolean;
    includeTrashed?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: LibraryItemTarget[];
    totalCount: number;
    returnedCount: number;
    offset: number;
    nextOffset?: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");

    const errors = validateSearchConditions(params.conditions);
    if (errors.length) {
      const detail = errors
        .map((error) =>
          error.validOperators?.length
            ? `${error.reason}. Valid operators: ${error.validOperators.join(", ")}`
            : error.reason,
        )
        .join("; ");
      throw new Error(`Invalid search conditions: ${detail}`);
    }

    const search = new Zotero.Search({ libraryID });
    if (params.joinMode === "any" || params.joinMode === "all") {
      search.addCondition("joinMode", params.joinMode as never, "");
    }
    // Zotero excludes trashed items unless told otherwise, so listing the
    // trash was impossible without this -- which in turn made restore
    // unusable, because nothing could enumerate what was in there.
    if (params.includeTrashed) {
      search.addCondition("deleted", "true" as never, "");
    }
    for (const entry of params.conditions) {
      const name = entry.mode
        ? `${entry.condition}/${entry.mode}`
        : entry.condition;
      search.addCondition(
        name as never,
        entry.operator as never,
        entry.value === undefined ? "" : (entry.value as never),
        entry.required,
      );
    }

    const rawIds: number[] = await search.search();

    const resolved: number[] = [];
    const seen = new Set<number>();
    for (const id of rawIds) {
      const item = Zotero.Items.get(id);
      if (!item) continue;
      let targetId = Number(id);
      if (params.resolveToParents) {
        const parentID = (item as { parentID?: number | false }).parentID;
        if (parentID) targetId = Number(parentID);
      } else if (
        (item as { parentID?: number | false }).parentID ||
        item.isAnnotation?.()
      ) {
        continue;
      }
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      resolved.push(targetId);
    }

    const offset =
      Number.isFinite(params.offset) && Number(params.offset) > 0
        ? Math.floor(Number(params.offset))
        : 0;
    const limit = Math.min(
      Math.max(
        Number.isFinite(params.limit) && Number(params.limit) > 0
          ? Math.floor(Number(params.limit))
          : 50,
        1,
      ),
      200,
    );
    // The window is taken on ids, so enrichment only runs for what is
    // actually returned.
    const page = resolved.slice(offset, offset + limit);

    const items: LibraryItemTarget[] = [];
    for (const itemId of page) {
      const item = this.getItem(itemId);
      if (!item) continue;
      const target = buildItemTargetFromItem(item);
      if (target) items.push(target);
    }

    const nextOffset = offset + page.length;
    return {
      items,
      totalCount: resolved.length,
      returnedCount: items.length,
      offset,
      nextOffset: nextOffset < resolved.length ? nextOffset : undefined,
    };
  }

  /**
   * Lists Zotero's item types and, optionally, the fields each one accepts.
   *
   * Without this the model guesses field names, and a guess is not a soft
   * failure: `setField` throws for a field the type does not have. Creating an
   * item of any type is impossible without knowing what types exist.
   */
  listItemTypes(params?: { itemType?: string; includeFields?: boolean }): {
    itemTypes: Array<{
      itemType: string;
      localized?: string;
      fields?: string[];
      creatorTypes?: string[];
    }>;
  } {
    const itemTypes = (
      Zotero as unknown as {
        ItemTypes?: {
          getTypes?: () => Array<{ id: number; name: string }>;
          getAll?: () => Array<{ id: number; name: string }>;
          getLocalizedString?: (idOrName: number | string) => string;
        };
      }
    ).ItemTypes;
    const itemFields = (
      Zotero as unknown as {
        ItemFields?: {
          getItemTypeFields?: (itemTypeId: number) => number[];
          getName?: (fieldId: number) => string;
        };
      }
    ).ItemFields;
    const creatorTypes = (
      Zotero as unknown as {
        CreatorTypes?: {
          getTypesForItemType?: (
            itemTypeId: number,
          ) => Array<{ id: number; name: string }>;
        };
      }
    ).CreatorTypes;

    const all = itemTypes?.getTypes?.() || itemTypes?.getAll?.() || [];
    const wanted = params?.itemType
      ? all.filter((entry) => entry.name === params.itemType)
      : all;

    return {
      itemTypes: wanted.map((entry) => {
        const row: {
          itemType: string;
          localized?: string;
          fields?: string[];
          creatorTypes?: string[];
        } = { itemType: entry.name };
        try {
          const localized = itemTypes?.getLocalizedString?.(entry.id);
          if (localized) row.localized = localized;
        } catch {
          // A missing localisation must not hide the type itself.
        }
        // Fields are only included on request or for a single type: all ~35
        // types with their fields is a large payload to spend on a lookup.
        if (params?.includeFields || params?.itemType) {
          try {
            row.fields = (itemFields?.getItemTypeFields?.(entry.id) || [])
              .map((fieldId) => itemFields?.getName?.(fieldId) || "")
              .filter(
                (name) => name && !NON_EDITABLE_METADATA_FIELDS.has(name),
              );
          } catch {
            row.fields = [];
          }
          try {
            row.creatorTypes = (
              creatorTypes?.getTypesForItemType?.(entry.id) || []
            ).map((creator) => creator.name);
          } catch {
            row.creatorTypes = [];
          }
        }
        return row;
      }),
    };
  }

  /**
   * Creates items from scratch.
   *
   * Everything the agent could add came from outside — an identifier lookup
   * or a file import — so a book with no DOI, a thesis, a dataset, or a
   * personal communication simply could not be entered. That is an ordinary
   * thing to ask of a reference manager.
   */
  async createItems(params: {
    libraryID: number;
    items: Array<{
      itemType: string;
      fields?: Record<string, string>;
      creators?: EditableArticleCreator[];
      tags?: string[];
      collections?: number[];
    }>;
  }): Promise<{
    createdCount: number;
    items: Array<{
      itemId?: number;
      itemType: string;
      title: string;
      status: "created" | "error";
      reason?: string;
    }>;
  }> {
    const results: Array<{
      itemId?: number;
      itemType: string;
      title: string;
      status: "created" | "error";
      reason?: string;
    }> = [];
    let createdCount = 0;

    for (const spec of params.items) {
      const itemType = String(spec.itemType || "").trim();
      const title = String(spec.fields?.title || "").trim();
      try {
        const itemTypeId = (
          Zotero as unknown as {
            ItemTypes?: { getID?: (name: string) => number | false };
          }
        ).ItemTypes?.getID?.(itemType);
        if (!itemTypeId) {
          results.push({
            itemType,
            title,
            status: "error",
            reason: `"${itemType}" is not a Zotero item type. Use library_search({ entity:'itemTypes', mode:'list' }) to see the valid ones.`,
          });
          continue;
        }
        const item = new Zotero.Item(itemType as never);
        item.libraryID = params.libraryID;

        const invalid: string[] = [];
        for (const [fieldName, value] of Object.entries(spec.fields || {})) {
          if (!isFieldValidForItemType(item, fieldName)) {
            invalid.push(fieldName);
            continue;
          }
          item.setField(fieldName, String(value ?? ""));
        }
        if (invalid.length) {
          results.push({
            itemType,
            title,
            status: "error",
            reason: `Fields not valid for ${itemType}: ${invalid.join(", ")}. Valid fields: ${listEditableFieldsForItem(item).join(", ")}.`,
          });
          continue;
        }

        if (spec.creators?.length) {
          item.setCreators(spec.creators as never);
        }
        for (const tag of spec.tags || []) {
          if (tag) item.addTag(String(tag));
        }
        for (const collectionId of spec.collections || []) {
          if (collectionId > 0) item.addToCollection(collectionId);
        }

        await item.saveTx();
        createdCount += 1;
        results.push({
          itemId: Number(item.id),
          itemType,
          title: title || String(item.getDisplayTitle?.() || ""),
          status: "created",
        });
      } catch (error) {
        results.push({
          itemType,
          title,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { createdCount, items: results };
  }

  /**
   * Moves an item under a different parent, or detaches it to top level.
   *
   * The capability matrix declared reparent allowed for notes and attachments
   * and nothing implemented it, so "move this note onto that paper" — an
   * everyday tidy-up — had no path but a raw script.
   */
  async reparentItems(params: {
    assignments: Array<{ itemId: number; parentItemId: number | null }>;
  }): Promise<{
    changedCount: number;
    items: Array<{
      itemId: number;
      title: string;
      status: "reparented" | "skipped" | "error";
      previousParentId?: number | null;
      reason?: string;
    }>;
  }> {
    const results: Array<{
      itemId: number;
      title: string;
      status: "reparented" | "skipped" | "error";
      previousParentId?: number | null;
      reason?: string;
    }> = [];
    let changedCount = 0;

    for (const assignment of params.assignments) {
      const rawItem = this.getItem(assignment.itemId);
      const resolution = resolveMatrixItem(
        rawItem,
        assignment.itemId,
        "reparent",
      );
      if ("refusal" in resolution) {
        results.push({
          itemId: assignment.itemId,
          title: rawItem
            ? normalizeText(rawItem.getDisplayTitle?.()) ||
              `Item ${assignment.itemId}`
            : `Item ${assignment.itemId}`,
          status: "error",
          reason: resolution.refusal,
        });
        continue;
      }
      const item = resolution.item;
      const title =
        normalizeText(item.getDisplayTitle?.()) || `Item ${item.id}`;
      const previousParentId =
        (item as unknown as { parentID?: number | false }).parentID || null;

      // A parent must be a regular item: Zotero cannot nest a note under an
      // attachment, and attaching to a child would silently produce an
      // unreachable item.
      if (assignment.parentItemId != null) {
        const parent = this.getItem(assignment.parentItemId);
        if (!parent) {
          results.push({
            itemId: Number(item.id),
            title,
            status: "error",
            reason: `No item with ID ${assignment.parentItemId} exists in this library`,
          });
          continue;
        }
        if (!parent.isRegularItem?.()) {
          results.push({
            itemId: Number(item.id),
            title,
            status: "error",
            reason:
              "A parent must be a regular bibliographic item; notes and attachments cannot hold children",
          });
          continue;
        }
      }

      if (previousParentId === (assignment.parentItemId ?? null)) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "skipped",
          previousParentId,
          reason: "Already attached there",
        });
        continue;
      }

      try {
        (item as unknown as { parentID: number | false }).parentID =
          assignment.parentItemId ?? false;
        await item.saveTx();
        changedCount += 1;
        results.push({
          itemId: Number(item.id),
          title,
          status: "reparented",
          previousParentId,
        });
      } catch (error) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { changedCount, items: results };
  }

  /**
   * Adds or removes Zotero's "Related" links between items.
   *
   * Relations are bidirectional in Zotero, so both sides are saved together;
   * writing one side leaves the pair inconsistent.
   */
  async relateItems(params: {
    itemId: number;
    relatedItemIds: number[];
    action: "add" | "remove";
  }): Promise<{
    itemId: number;
    changedCount: number;
    items: Array<{
      relatedItemId: number;
      status: "related" | "unrelated" | "skipped" | "error";
      reason?: string;
    }>;
  }> {
    const rawItem = this.getItem(params.itemId);
    const resolution = resolveMatrixItem(rawItem, params.itemId, "relate");
    if ("refusal" in resolution) throw new Error(resolution.refusal);
    const item = resolution.item;

    const results: Array<{
      relatedItemId: number;
      status: "related" | "unrelated" | "skipped" | "error";
      reason?: string;
    }> = [];
    let changedCount = 0;

    for (const relatedItemId of params.relatedItemIds) {
      if (relatedItemId === params.itemId) {
        results.push({
          relatedItemId,
          status: "skipped",
          reason: "An item cannot be related to itself",
        });
        continue;
      }
      const otherRaw = this.getItem(relatedItemId);
      const otherResolution = resolveMatrixItem(
        otherRaw,
        relatedItemId,
        "relate",
      );
      if ("refusal" in otherResolution) {
        results.push({
          relatedItemId,
          status: "error",
          reason: otherResolution.refusal,
        });
        continue;
      }
      const other = otherResolution.item;
      let forward = false;
      let backward = false;
      try {
        const db = (
          Zotero as unknown as {
            DB?: {
              executeTransaction?: (task: () => Promise<void>) => Promise<void>;
            };
          }
        ).DB;
        const forwardItem = item as Zotero.Item & {
          save?: () => Promise<unknown>;
        };
        const backwardItem = other as Zotero.Item & {
          save?: () => Promise<unknown>;
        };
        if (
          typeof db?.executeTransaction !== "function" ||
          typeof forwardItem.save !== "function" ||
          typeof backwardItem.save !== "function"
        ) {
          throw new Error(
            "Atomic bidirectional relation persistence is unavailable",
          );
        }
        await db.executeTransaction(async () => {
          // Both sides are evaluated, never short-circuited: `a && b` would
          // apply one direction and skip the other, leaving Zotero's
          // bidirectional relation half-written and permanently inconsistent.
          if (params.action === "add") {
            forward = item.addRelatedItem(other);
            backward = other.addRelatedItem(item);
          } else {
            forward = await item.removeRelatedItem(other);
            backward = await other.removeRelatedItem(item);
          }
          if (forward !== backward) {
            // One side was already in the target state. Put the other side
            // back so the pair remains symmetric without committing either.
            if (params.action === "add") {
              if (forward) await item.removeRelatedItem(other);
              if (backward) await other.removeRelatedItem(item);
            } else {
              if (forward) item.addRelatedItem(other);
              if (backward) other.addRelatedItem(item);
            }
            return;
          }
          if (forward && backward) {
            await forwardItem.save();
            await backwardItem.save();
          }
        });
        const changed = forward && backward;
        if (!changed) {
          results.push({
            relatedItemId,
            status: "skipped",
            reason:
              params.action === "add" ? "Already related" : "Was not related",
          });
          continue;
        }
        changedCount += 1;
        results.push({
          relatedItemId,
          status: params.action === "add" ? "related" : "unrelated",
        });
      } catch (error) {
        // A rejected transaction rolls the database back, but Zotero item
        // objects can retain their in-memory relation mutation. Restore that
        // representation as well so a later retry starts from database truth.
        try {
          if (params.action === "add") {
            if (forward) await item.removeRelatedItem(other);
            if (backward) await other.removeRelatedItem(item);
          } else {
            if (forward) item.addRelatedItem(other);
            if (backward) other.addRelatedItem(item);
          }
        } catch {
          await Promise.all([
            (
              item as Zotero.Item & { reload?: () => Promise<unknown> }
            ).reload?.(),
            (
              other as Zotero.Item & { reload?: () => Promise<unknown> }
            ).reload?.(),
          ]);
        }
        results.push({
          relatedItemId,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { itemId: params.itemId, changedCount, items: results };
  }

  async listItemsByFilters(params: {
    libraryID: number;
    filters?: AgentLibraryFilters;
    limit?: number;
    offset?: number;
    sort?: "dateAdded" | "title";
    order?: "asc" | "desc";
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    try {
      const search = buildAgentLibrarySearch(libraryID, params.filters || {});
      const rawIds: number[] = await search.search();
      // Drop child items (child notes, annotations, attachments)
      const topIds: number[] = [];
      const seen = new Set<number>();
      for (const id of rawIds) {
        const item = Zotero.Items.get(id);
        if (item && !item.parentID && !item.isAnnotation?.() && !seen.has(id)) {
          seen.add(id);
          topIds.push(id);
        }
      }
      const snapshot = await libraryIndexService.getSnapshot(libraryID);
      const matchingIds: number[] = [];
      for (const id of topIds) {
        const indexed = snapshot.itemById.get(id);
        if (!indexed) continue;
        const wantsDeleted = params.filters?.deleted === true;
        if (wantsDeleted ? !indexed.deleted : indexed.deleted) continue;
        const hasPdf = (snapshot.childAttachmentIdsByItemId.get(id) || []).some(
          (attachmentId) => snapshot.attachmentById.get(attachmentId)?.isPdf,
        );
        if (
          params.filters?.hasPdf !== undefined &&
          hasPdf !== params.filters.hasPdf
        ) {
          continue;
        }
        const year = Number(indexed.year);
        if (
          params.filters?.yearFrom != null &&
          (!year || year < params.filters.yearFrom)
        ) {
          continue;
        }
        if (
          params.filters?.yearTo != null &&
          (!year || year > params.filters.yearTo)
        ) {
          continue;
        }
        matchingIds.push(id);
      }
      return {
        items: buildItemTargetsForIds(
          this,
          sortAndPageIndexIds(snapshot, matchingIds, params),
        ),
        totalCount: matchingIds.length,
      };
    } catch (error) {
      // The in-memory path reads the live library, so it cannot answer a
      // trash query. Falling back would quietly return the user's ordinary
      // items when they asked what was in the trash.
      if (params.filters?.deleted) throw error;
      // Otherwise a genuine fallback: the in-memory path applies the same
      // filters and returns correct results. It is logged because silence is
      // what masked the `year` operator bug for as long as it existed.
      Zotero.debug(
        `[agent] Zotero.Search listing failed, falling back to in-memory filtering: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this._listItemsByFiltersInMemory(params);
    }
  }

  private async _listItemsByFiltersInMemory(params: {
    libraryID: number;
    filters?: AgentLibraryFilters;
    limit?: number;
    offset?: number;
    sort?: "dateAdded" | "title";
    order?: "asc" | "desc";
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const filters = params.filters || {};
    const snapshot = await libraryIndexService.getSnapshot(params.libraryID);
    const author = normalizeLibraryIndexText(filters.author || "");
    const ids = orderedIndexIds(snapshot, (item) => {
      if (!indexItemMatchesType(item, filters.itemType)) return false;
      if (
        filters.collectionId &&
        !item.collectionIds.includes(filters.collectionId)
      ) {
        return false;
      }
      if (filters.unfiled && item.collectionIds.length) return false;
      if (
        author &&
        !normalizeLibraryIndexText(item.firstCreator).includes(author)
      ) {
        return false;
      }
      const year = Number(item.year);
      if (filters.yearFrom != null && (!year || year < filters.yearFrom)) {
        return false;
      }
      if (filters.yearTo != null && (!year || year > filters.yearTo)) {
        return false;
      }
      if (
        filters.tag &&
        ![...item.tags, ...item.automaticTags].includes(filters.tag)
      ) {
        return false;
      }
      if (filters.hasPdf !== undefined) {
        const hasPdf = (
          snapshot.childAttachmentIdsByItemId.get(item.itemId) || []
        ).some((attachmentId) =>
          Boolean(snapshot.attachmentById.get(attachmentId)?.isPdf),
        );
        if (hasPdf !== filters.hasPdf) return false;
      }
      return true;
    });
    return {
      items: buildItemTargetsForIds(
        this,
        sortAndPageIndexIds(snapshot, ids, params),
      ),
      totalCount: ids.length,
    };
  }

  /** See `NoteCapability.listStandaloneNotes`. */
  async listStandaloneNotes(params: {
    libraryID: number;
    collectionId?: number;
    limit?: number;
  }): Promise<{ notes: LibraryItemTarget[]; totalCount: number }> {
    return this.noteCapability.listStandaloneNotes(params);
  }

  /** See `NoteCapability.getStandaloneNoteContent`. */
  getStandaloneNoteContent(params: { noteId: number }): PaperNoteRecord | null {
    return this.noteCapability.getStandaloneNoteContent(params);
  }

  /** See `AttachmentCapability.getAttachmentInfo`. */
  getAttachmentInfo(params: { attachmentId: number }): {
    attachmentId: number;
    parentItemId?: number;
    title: string;
    contentType: string;
    filename?: string;
    hasFile: boolean;
    linkMode: string;
  } | null {
    return this.attachmentCapability.getAttachmentInfo(params);
  }

  async searchAllLibraryItems(params: {
    libraryID: number;
    query: string;
    filters?: AgentLibraryFilters;
    allowedItemIds?: number[];
    limit?: number;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID || !params.query?.trim()) {
      return { items: [], totalCount: 0 };
    }
    const normalizedLimit = normalizeResultLimit(params.limit) || 50;
    const allowedItemIds = Array.isArray(params.allowedItemIds)
      ? new Set(
          params.allowedItemIds
            .map((itemId) =>
              Number.isFinite(itemId) && itemId > 0 ? Math.floor(itemId) : 0,
            )
            .filter(Boolean),
        )
      : null;
    try {
      const search = params.filters
        ? buildAgentLibrarySearch(libraryID, params.filters)
        : new Zotero.Search({ libraryID });
      search.addCondition(
        "quicksearch-everything",
        "contains",
        params.query.trim(),
      );
      const rawIds: number[] = await search.search();
      // Resolve child items (notes/attachments) to their top-level parent, de-duplicate
      const resolvedIds: number[] = [];
      const seen = new Set<number>();
      for (const id of rawIds) {
        const item = Zotero.Items.get(id);
        if (!item) continue;
        const topId = (item.parentID as number | false | undefined) || id;
        if (allowedItemIds && !allowedItemIds.has(topId)) continue;
        if (!seen.has(topId)) {
          seen.add(topId);
          resolvedIds.push(topId);
        }
      }
      const targets: LibraryItemTarget[] = [];
      for (const itemId of resolvedIds) {
        const item = this.getItem(itemId);
        if (!item) continue;
        const target = buildItemTargetFromItem(item);
        if (
          target &&
          libraryItemTargetMatchesFilters(target, params.filters) &&
          libraryItemTargetMatchesYear(target, params.filters)
        ) {
          targets.push(target);
        }
      }
      return {
        items:
          normalizedLimit && targets.length > normalizedLimit
            ? targets.slice(0, normalizedLimit)
            : targets,
        totalCount: targets.length,
      };
    } catch (error) {
      // Deliberately not swallowed into an empty result. Reporting "no
      // matching library results" for a *broken query* is indistinguishable
      // from a genuine miss, which is exactly how the `year` operator bug
      // stayed invisible: the agent confidently told users their library had
      // nothing. A thrown error surfaces as a tool failure instead.
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** See `NoteCapability.searchAllNotes`. */
  async searchAllNotes(params: {
    libraryID: number;
    collectionId?: number;
    query: string;
    limit?: number;
  }): Promise<
    Array<
      LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
    >
  > {
    return this.noteCapability.searchAllNotes(params);
  }

  /** See `AttachmentCapability.indexPdfAttachment`. */
  async indexPdfAttachment(params: { attachmentId: number }): Promise<{
    attachmentId: number;
    indexingState: string;
    triggered: boolean;
  }> {
    return this.attachmentCapability.indexPdfAttachment(params);
  }

  /** See `TagCapability.listLibraryTags`. */
  async listLibraryTags(params: {
    libraryID: number;
    query?: string;
    limit?: number;
  }): Promise<{ name: string; type: number }[]> {
    return this.tagCapability.listLibraryTags(params);
  }

  listAllLibraries(): {
    libraryID: number;
    name: string;
    type: string;
    editable: boolean;
  }[] {
    return Zotero.Libraries.getAll().map((lib) => ({
      libraryID: lib.libraryID,
      name: lib.name,
      type: Zotero.Libraries.getType(lib.libraryID),
      editable: Zotero.Libraries.isEditable(lib.libraryID),
    }));
  }

  /** See `TagCapability.applyTagAssignments`. */
  async applyTagAssignments(params: {
    assignments: BatchTagAssignment[];
  }): Promise<{
    selectedCount: number;
    updatedCount: number;
    skippedCount: number;
    items: BatchTagItemResult[];
  }> {
    return this.tagCapability.applyTagAssignments(params);
  }

  /** See `CollectionCapability.setItemCollections`. */
  async setItemCollections(params: {
    assignments: ItemCollectionSet[];
  }): Promise<{
    items: BatchMoveItemResult[];
    changedCount: number;
    priorCollections: ItemCollectionSet[];
  }> {
    return this.collectionCapability.setItemCollections(params);
  }

  /** See `CollectionCapability.addItemsToCollections`. */
  async addItemsToCollections(params: {
    assignments: BatchMoveAssignment[];
    mode?: "add" | "move";
    from?: number | "all";
  }): Promise<{
    selectedCount: number;
    movedCount: number;
    addedCount: number;
    skippedCount: number;
    collections: CollectionSummary[];
    items: BatchMoveItemResult[];
    priorCollections?: ItemCollectionSet[];
  }> {
    return this.collectionCapability.addItemsToCollections(params);
  }

  /** See `NoteCapability.saveAnswerToNote`. */
  async saveAnswerToNote(params: {
    item: Zotero.Item | null;
    libraryID?: number;
    content: string;
    modelName: string;
    target?: "item" | "standalone";
    appendToTrackedNote?: boolean;
    generatedImages?: GeneratedChatImage[];
    /** Collections to file a standalone note into. Ignored for child notes. */
    collections?: number[];
  }): Promise<SaveAnswerToNoteResult> {
    return this.noteCapability.saveAnswerToNote(params);
  }

  /** See `NoteCapability.getPaperNotes`. */
  getPaperNotes(params: {
    item: Zotero.Item | null | undefined;
    maxNotes?: number;
  }): PaperNoteRecord[] {
    return this.noteCapability.getPaperNotes(params);
  }

  /** See `NoteCapability.getPaperAnnotations`. */
  getPaperAnnotations(params: {
    item: Zotero.Item | null | undefined;
    maxAnnotations?: number;
  }): PaperAnnotationRecord[] {
    return this.noteCapability.getPaperAnnotations(params);
  }

  /** See `CollectionCapability.createCollection`. */
  async createCollection(params: {
    name: string;
    parentCollectionId?: number;
    libraryID: number;
  }): Promise<CollectionSummary> {
    return this.collectionCapability.createCollection(params);
  }

  /** See `CollectionCapability.snapshotCollectionForDelete`. */
  snapshotCollectionForDelete(params: { collectionId: number }): {
    name: string;
    parentCollectionId?: number;
    libraryID: number;
    itemIds: number[];
    childCollectionCount: number;
  } | null {
    return this.collectionCapability.snapshotCollectionForDelete(params);
  }

  /** See `CollectionCapability.updateCollection`. */
  async updateCollection(params: {
    collectionId: number;
    name?: string;
    parentCollectionId?: number | null;
  }): Promise<{
    collectionId: number;
    name: string;
    previousName: string;
    previousParentCollectionId: number | null;
    status: "updated" | "unchanged" | "not_found";
    reason?: string;
  }> {
    return this.collectionCapability.updateCollection(params);
  }

  /** See `TagCapability.updateLibraryTag`. */
  async updateLibraryTag(params: {
    libraryID: number;
    action: "rename" | "delete" | "merge" | "setColor";
    tag: string;
    newTag?: string;
    color?: string;
    position?: number;
  }): Promise<{
    action: string;
    tag: string;
    newTag?: string;
    destinationExisted?: boolean;
    status: "applied" | "not_found" | "error";
    itemCount?: number;
    reason?: string;
  }> {
    return this.tagCapability.updateLibraryTag(params);
  }

  /** See `TagCapability.setItemTags`. */
  async setItemTags(params: {
    assignments: Array<{ itemId: number; tags: string[] }>;
  }): Promise<{
    changedCount: number;
    items: Array<{
      itemId: number;
      title: string;
      status: "updated" | "skipped" | "error";
      previousTags?: string[];
      reason?: string;
    }>;
  }> {
    return this.tagCapability.setItemTags(params);
  }

  /** See `CollectionCapability.listSavedSearches`. */
  listSavedSearches(libraryID: number): Array<{
    savedSearchId: number;
    name: string;
    conditions: Array<{ condition: string; operator: string; value: string }>;
  }> {
    return this.collectionCapability.listSavedSearches(libraryID);
  }

  /** See `CollectionCapability.saveSavedSearch`. */
  async saveSavedSearch(params: {
    libraryID: number;
    name: string;
    conditions: AgentSearchCondition[];
    joinMode?: "all" | "any";
    savedSearchId?: number;
  }): Promise<{
    savedSearchId: number;
    name: string;
    status: "created" | "updated";
  }> {
    return this.collectionCapability.saveSavedSearch(params);
  }

  /** See `CollectionCapability.deleteSavedSearch`. */
  async deleteSavedSearch(params: {
    savedSearchId: number;
    permanent?: boolean;
  }): Promise<{
    savedSearchId: number;
    status: "trashed" | "erased" | "not_found";
  }> {
    return this.collectionCapability.deleteSavedSearch(params);
  }

  /** Reads the preferences the agent is allowed to see. */
  listSettings(): Array<{
    key: string;
    value: unknown;
    type: string;
    description: string;
  }> {
    const prefs = (
      Zotero as unknown as { Prefs?: { get?: (key: string) => unknown } }
    ).Prefs;
    return Object.entries(AGENT_WRITABLE_PREFS).map(([key, spec]) => {
      let value: unknown = undefined;
      try {
        value = prefs?.get?.(key);
      } catch {
        // An unset pref reads as undefined rather than failing the listing.
      }
      return { key, value, type: spec.type, description: spec.description };
    });
  }

  getSettingNativeState(key: string): { exists: boolean; value: unknown } {
    const setting = this.listSettings().find((entry) => entry.key === key);
    return setting
      ? { exists: true, value: setting.value }
      : { exists: false, value: undefined };
  }

  /** Restore an allowlisted preference without applying user-input coercion. */
  restoreSetting(params: {
    key: string;
    existed: boolean;
    value?: unknown;
  }): void {
    if (!AGENT_WRITABLE_PREFS[params.key]) {
      throw new Error(`Preference "${params.key}" is not agent-writable`);
    }
    const prefs = (
      Zotero as unknown as {
        Prefs?: {
          set?: (key: string, value: unknown) => void;
          clear?: (key: string) => void;
        };
      }
    ).Prefs;
    if (params.existed) {
      if (typeof prefs?.set !== "function") {
        throw new Error("Zotero.Prefs.set is unavailable");
      }
      prefs.set(params.key, params.value);
      return;
    }
    if (typeof prefs?.clear !== "function") {
      throw new Error(
        "Zotero.Prefs.clear is unavailable; an originally unset preference cannot be restored safely",
      );
    }
    prefs.clear(params.key);
  }

  /**
   * Writes one allowlisted preference.
   *
   * Anything outside the allowlist is refused by name. `Zotero.Prefs` also
   * holds sync credentials, the data directory and proxy settings, and an
   * agent that can rewrite those can lock a user out of their own library.
   */
  async updateSetting(params: { key: string; value: unknown }): Promise<{
    key: string;
    previousValue: unknown;
    value: unknown;
    status: "updated" | "unchanged" | "refused";
    reason?: string;
  }> {
    const spec = AGENT_WRITABLE_PREFS[params.key];
    if (!spec) {
      return {
        key: params.key,
        previousValue: undefined,
        value: params.value,
        status: "refused",
        reason: `"${params.key}" is not a preference the agent may change. The ones it may are listed by library_settings with action:'list'.`,
      };
    }
    const prefs = (
      Zotero as unknown as {
        Prefs?: {
          get?: (key: string) => unknown;
          set?: (key: string, value: unknown) => void;
        };
      }
    ).Prefs;
    if (!prefs?.set) {
      return {
        key: params.key,
        previousValue: undefined,
        value: params.value,
        status: "refused",
        reason: "Zotero.Prefs is not available in this build",
      };
    }

    let coerced: unknown = params.value;
    if (spec.type === "boolean") coerced = Boolean(params.value);
    else if (spec.type === "number") {
      const numeric = Number(params.value);
      if (!Number.isFinite(numeric)) {
        return {
          key: params.key,
          previousValue: prefs.get?.(params.key),
          value: params.value,
          status: "refused",
          reason: `"${params.key}" expects a number`,
        };
      }
      coerced = numeric;
    } else coerced = String(params.value ?? "");

    const previousValue = prefs.get?.(params.key);
    if (previousValue === coerced) {
      return {
        key: params.key,
        previousValue,
        value: coerced,
        status: "unchanged",
      };
    }
    prefs.set(params.key, coerced);
    return {
      key: params.key,
      previousValue,
      value: coerced,
      status: "updated",
    };
  }

  /** Sync state, and a way to start one. */
  getSyncStatus(): {
    configured: boolean;
    username?: string;
    lastSyncAt?: number;
    inProgress: boolean;
  } {
    const sync = Zotero as unknown as {
      Sync?: {
        Runner?: { syncInProgress?: boolean; lastSyncStatus?: string };
      };
      Users?: { getCurrentUsername?: () => string };
      Prefs?: { get?: (key: string) => unknown };
    };
    let username: string | undefined;
    try {
      username = sync.Users?.getCurrentUsername?.() || undefined;
    } catch {
      username = undefined;
    }
    return {
      configured: Boolean(username),
      username,
      inProgress: Boolean(sync.Sync?.Runner?.syncInProgress),
    };
  }

  /** The export formats Zotero can write. */
  listExportFormats(): Array<{ id: string; label: string }> {
    const translators = (
      Zotero as unknown as {
        Translators?: {
          getAllForType?: (
            type: string,
          ) => Promise<Array<{ translatorID: string; label: string }>>;
        };
      }
    ).Translators;
    void translators;
    // Deliberately synchronous and static: the async translator listing is a
    // separate call shape, and these are the formats users actually name.
    return [
      { id: "14763d24-8ba0-45df-8f52-b8d1108e7ac9", label: "BibTeX" },
      { id: "9cb70025-a888-4a29-a210-93ec52da40d4", label: "BibLaTeX" },
      { id: "32d59d2d-b65a-4da4-b0a3-bdd3cfb979e7", label: "RIS" },
      { id: "bc03b4fe-436d-4a1f-ba59-de4d2d7a63f7", label: "CSL JSON" },
      { id: "14763d25-8ba0-45df-8f52-b8d1108e7ac9", label: "Zotero RDF" },
      { id: "b8f9f5e6-b6a9-4b0e-a3f0-9e29ff9e14cf", label: "Simple Evernote" },
    ];
  }

  /**
   * Exports items through a Zotero translator.
   *
   * All export was unreachable: the census found the whole domain at zero
   * covered operations, so "give me these as BibTeX" had no path.
   */
  async exportItems(params: {
    itemIds: number[];
    translatorId: string;
  }): Promise<{ output: string; itemCount: number }> {
    const TranslateExport = (
      Zotero as unknown as {
        Translate?: { Export?: new () => unknown };
      }
    ).Translate?.Export;
    if (!TranslateExport) {
      throw new Error("Zotero.Translate.Export is not available in this build");
    }
    const items = params.itemIds
      .map((itemId) => this.getItem(itemId))
      .filter((item): item is Zotero.Item => Boolean(item));
    if (!items.length) {
      throw new Error("None of those item IDs resolved to an item.");
    }

    const translation = new TranslateExport() as {
      setItems: (items: unknown[]) => void;
      setTranslator: (id: string) => void;
      setHandler: (
        event: string,
        handler: (...args: unknown[]) => void,
      ) => void;
      translate: () => void;
      string?: string;
    };
    translation.setItems(items);
    translation.setTranslator(params.translatorId);

    return new Promise((resolve, reject) => {
      translation.setHandler("done", (_obj: unknown, worked: unknown) => {
        if (!worked) {
          reject(
            new Error(
              `Zotero could not export with translator ${params.translatorId}.`,
            ),
          );
          return;
        }
        resolve({
          output: String(translation.string || ""),
          itemCount: items.length,
        });
      });
      try {
        translation.translate();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** The citation styles installed in Zotero. */
  listCitationStyles(): Array<{ id: string; title: string }> {
    const styles = (
      Zotero as unknown as {
        Styles?: {
          getVisible?: () => Array<{ styleID: string; title: string }>;
          getAll?: () => Record<string, { styleID: string; title: string }>;
        };
      }
    ).Styles;
    try {
      const visible = styles?.getVisible?.();
      if (visible?.length) {
        return visible.map((style) => ({
          id: String(style.styleID),
          title: normalizeText(style.title),
        }));
      }
      return Object.values(styles?.getAll?.() || {}).map((style) => ({
        id: String(style.styleID),
        title: normalizeText(style.title),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Formats citations or a bibliography through Zotero's own CSL engine.
   *
   * The most dangerous everyday gap in the whole census: asked for "the APA
   * reference for this paper" the agent had no tool at all, so it produced a
   * plausible-looking citation from memory. A fabricated reference is worse
   * than a refusal in a reference manager, and it is the one thing this
   * product exists to get right.
   */
  formatBibliography(params: {
    itemIds: number[];
    styleId?: string;
    locale?: string;
    format?: "text" | "html";
    mode?: "bibliography" | "citation";
  }): {
    styleId: string;
    styleTitle: string;
    output: string;
    format: "text" | "html";
    itemCount: number;
  } {
    const Styles = (
      Zotero as unknown as {
        Styles?: {
          get?: (id: string) => unknown;
          getVisible?: () => Array<{ styleID: string; title: string }>;
        };
      }
    ).Styles;
    const Cite = (
      Zotero as unknown as {
        Cite?: {
          makeFormattedBibliographyOrCitationList?: (
            engine: unknown,
            items: unknown[],
            format: string,
          ) => string;
        };
      }
    ).Cite;
    if (!Styles?.get || !Cite?.makeFormattedBibliographyOrCitationList) {
      throw new Error(
        "Zotero's citation engine is not available in this build, so a citation cannot be formatted. Do not write one from memory.",
      );
    }

    const styleId =
      params.styleId ||
      String(
        (
          Zotero as unknown as {
            Prefs?: { get?: (key: string) => unknown };
          }
        ).Prefs?.get?.("export.quickCopy.setting") || "",
      ).replace(/^bibliography(?:\/[^/]*)?=/, "") ||
      "http://www.zotero.org/styles/apa";

    const style = Styles.get(styleId) as {
      title?: string;
      getCiteProc?: (
        locale: string,
        format: string,
        options?: { cache?: boolean },
      ) => {
        free?: () => void;
        updateItems?: (ids: number[]) => void;
        previewCitationCluster?: (
          citation: unknown,
          a: unknown[],
          b: unknown[],
          format: string,
        ) => string;
      };
    } | null;
    if (!style?.getCiteProc) {
      throw new Error(
        `Citation style "${styleId}" is not installed. List the available ones with library_search({ entity:'citationStyles', mode:'list' }).`,
      );
    }

    const items = params.itemIds
      .map((itemId) => this.getItem(itemId))
      .filter((item): item is Zotero.Item => Boolean(item))
      .filter((item) => !item.isNote?.());
    if (!items.length) {
      throw new Error("None of those item IDs resolved to a citable item.");
    }

    const outputFormat = params.format === "html" ? "html" : "text";
    const locale = params.locale || "en-US";
    const engine = style.getCiteProc(locale, outputFormat, { cache: true });
    try {
      if (params.mode === "citation") {
        engine.updateItems?.(items.map((item) => Number(item.id)));
        const output =
          engine.previewCitationCluster?.(
            {
              citationItems: items.map((item) => ({ id: item.id })),
              properties: {},
            },
            [],
            [],
            outputFormat,
          ) || "";
        return {
          styleId,
          styleTitle: normalizeText(style.title) || styleId,
          output,
          format: outputFormat,
          itemCount: items.length,
        };
      }
      const output =
        Cite.makeFormattedBibliographyOrCitationList(
          engine,
          items,
          outputFormat,
        ) || "";
      return {
        styleId,
        styleTitle: normalizeText(style.title) || styleId,
        output,
        format: outputFormat,
        itemCount: items.length,
      };
    } finally {
      engine.free?.();
    }
  }

  /**
   * Formats document citation clusters and keeps bibliography entries paired
   * with their Zotero items. Unlike formatBibliography(), this preserves the
   * structure needed for source navigation and multi-surface serialization.
   */
  formatStructuredCitations(params: {
    clusters: Array<{
      citationId: string;
      items: Array<{ itemId: number; pageIndex?: number }>;
    }>;
    styleId?: string;
    locale?: string;
  }): {
    styleId: string;
    styleTitle: string;
    locale: string;
    clusters: Array<{ citationId: string; text: string; html: string }>;
    bibliographyEntries: Array<{
      itemId: number;
      text: string;
      html: string;
    }>;
  } {
    const Styles = (
      Zotero as unknown as {
        Styles?: { get?: (id: string) => unknown };
      }
    ).Styles;
    if (!Styles?.get) {
      throw new Error("Zotero's citation style registry is unavailable");
    }
    const styleId =
      params.styleId ||
      String(
        (
          Zotero as unknown as {
            Prefs?: { get?: (key: string) => unknown };
          }
        ).Prefs?.get?.("export.quickCopy.setting") || "",
      ).replace(/^bibliography(?:\/[^/]*)?=/, "") ||
      "http://www.zotero.org/styles/apa";
    const locale = params.locale || "en-US";
    const style = Styles.get(styleId) as {
      title?: string;
      getCiteProc?: (
        locale: string,
        format: string,
        options?: { cache?: boolean },
      ) => {
        free?: () => void;
        updateItems?: (ids: number[]) => void;
        previewCitationCluster?: (
          citation: unknown,
          citationsPre: Array<[string, number]>,
          citationsPost: Array<[string, number]>,
          format: string,
        ) => string;
        makeBibliography?: () =>
          | [{ entry_ids?: Array<Array<string | number>> }, string[]]
          | false;
      };
    };
    if (!style?.getCiteProc) {
      throw new Error(`Citation style "${styleId}" is not installed`);
    }
    const itemIds = Array.from(
      new Set(
        params.clusters.flatMap((cluster) =>
          cluster.items.map((item) => Number(item.itemId)),
        ),
      ),
    ).filter((itemId) => Number.isInteger(itemId) && itemId > 0);
    if (!itemIds.length) {
      throw new Error("A structured citation bundle requires citable items");
    }
    const format = (outputFormat: "text" | "html") => {
      const engine = style.getCiteProc!(locale, outputFormat, { cache: true });
      try {
        engine.updateItems?.(itemIds);
        const clusters = params.clusters.map((cluster) => {
          const output =
            engine.previewCitationCluster?.(
              {
                citationID: cluster.citationId,
                citationItems: cluster.items.map((item) => ({
                  id: item.itemId,
                  ...(typeof item.pageIndex === "number"
                    ? { locator: String(item.pageIndex + 1), label: "page" }
                    : {}),
                })),
                properties: { noteIndex: 0 },
              },
              // previewCitationCluster() does not register the previewed
              // citation in citeproc's citation registry. Passing an earlier
              // preview as citationsPre therefore makes Zotero look up a
              // citation that does not exist and crashes on citationItems.
              // Document clusters are serialized independently, so preview
              // each one without synthetic prior/post citation IDs.
              [],
              [],
              outputFormat,
            ) || "";
          return { citationId: cluster.citationId, output };
        });
        const bibliography = engine.makeBibliography?.();
        if (!bibliography) {
          throw new Error(
            `Citation style "${styleId}" did not produce a bibliography`,
          );
        }
        const [metadata, entries] = bibliography;
        const entryIds = metadata.entry_ids || [];
        const bibliographyEntries = entries.map((output, index) => ({
          itemId: Number(entryIds[index]?.[0] || 0),
          output,
        }));
        if (
          bibliographyEntries.length !== itemIds.length ||
          bibliographyEntries.some((entry) => !entry.itemId)
        ) {
          throw new Error(
            "Zotero's citation engine returned an unresolvable bibliography",
          );
        }
        return { clusters, bibliographyEntries };
      } finally {
        engine.free?.();
      }
    };
    const textOutput = format("text");
    const htmlOutput = format("html");
    const htmlClusters = new Map(
      htmlOutput.clusters.map((cluster) => [
        cluster.citationId,
        cluster.output,
      ]),
    );
    const htmlEntries = new Map(
      htmlOutput.bibliographyEntries.map((entry) => [
        entry.itemId,
        entry.output,
      ]),
    );
    return {
      styleId,
      styleTitle: normalizeText(style.title) || styleId,
      locale,
      clusters: textOutput.clusters.map((cluster) => ({
        citationId: cluster.citationId,
        text: cluster.output,
        html: htmlClusters.get(cluster.citationId) || cluster.output,
      })),
      bibliographyEntries: textOutput.bibliographyEntries.map((entry) => ({
        itemId: entry.itemId,
        text: entry.output,
        html: htmlEntries.get(entry.itemId) || entry.output,
      })),
    };
  }

  /** See `CollectionCapability.deleteCollection`. */
  async deleteCollection(params: {
    collectionId: number;
    deleteItems?: boolean;
    permanent?: boolean;
  }): Promise<void> {
    return this.collectionCapability.deleteCollection(params);
  }

  /** See `CollectionCapability.restoreCollections`. */
  async restoreCollections(params: {
    collectionIds: number[];
  }): Promise<{ restoredCount: number; collectionIds: number[] }> {
    return this.collectionCapability.restoreCollections(params);
  }

  /** See `TagCapability.removeTagsFromItem`. */
  async removeTagsFromItem(params: {
    itemId: number;
    tags: string[];
  }): Promise<{ removed: string[] }> {
    return this.tagCapability.removeTagsFromItem(params);
  }

  /** See `CollectionCapability.getItemCollectionIds`. */
  getItemCollectionIds(itemId: number): number[] {
    return this.collectionCapability.getItemCollectionIds(itemId);
  }

  /** See `CollectionCapability.removeItemFromCollection`. */
  async removeItemFromCollection(params: {
    itemId: number;
    collectionId: number;
  }): Promise<{ removed: boolean; reason?: string }> {
    return this.collectionCapability.removeItemFromCollection(params);
  }

  async findRelatedPapersInLibrary(params: {
    libraryID: number;
    referenceItemId: number;
    limit?: number;
  }): Promise<{
    referenceTitle: string;
    relatedPapers: RelatedPaperResult[];
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const referenceItem = this.resolveBibliographicItem(
      this.getItem(params.referenceItemId),
    );
    if (!referenceItem) throw new Error("Reference paper not found");
    const referenceTarget = buildPaperTargetFromItem(referenceItem);
    if (!referenceTarget)
      throw new Error("Reference paper has no PDF attachment");
    const limit =
      Number.isFinite(params.limit) && (params.limit as number) > 0
        ? Math.floor(params.limit as number)
        : 10;
    const refTitle = normalizeText(referenceTarget.title).toLowerCase();
    const refTitleWords = new Set(
      refTitle.split(/\W+/).filter((w) => w.length > 3),
    );
    const refAuthor = normalizeText(
      referenceTarget.firstCreator || "",
    ).toLowerCase();
    const refYear = referenceTarget.year ? Number(referenceTarget.year) : null;
    const refJournal = normalizeText(
      String(referenceItem.getField?.("publicationTitle") ?? ""),
    ).toLowerCase();
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const scored: RelatedPaperResult[] = [];
    for (const candidateId of orderedGatewayPaperIds(snapshot)) {
      if (candidateId === referenceTarget.itemId) continue;
      const item = this.resolveBibliographicItem(this.getItem(candidateId));
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (!target) continue;
      let score = 0;
      const reasons: string[] = [];
      const candAuthor = normalizeText(target.firstCreator || "").toLowerCase();
      if (refAuthor && candAuthor && refAuthor === candAuthor) {
        score += 40;
        reasons.push(`Same first author: ${target.firstCreator}`);
      }
      const candTitle = normalizeText(target.title).toLowerCase();
      const candTitleWords = new Set(
        candTitle.split(/\W+/).filter((w) => w.length > 3),
      );
      const sharedWords = [...refTitleWords].filter((w) =>
        candTitleWords.has(w),
      );
      if (sharedWords.length >= 2) {
        score += Math.min(sharedWords.length * 8, 30);
        reasons.push(
          `Shared title keywords: ${sharedWords.slice(0, 3).join(", ")}`,
        );
      }
      const candJournal = normalizeText(
        String(item.getField?.("publicationTitle") ?? ""),
      ).toLowerCase();
      if (refJournal && candJournal && refJournal === candJournal) {
        score += 15;
        reasons.push(`Same journal: ${item.getField?.("publicationTitle")}`);
      }
      const candYear = target.year ? Number(target.year) : null;
      if (refYear && candYear && Math.abs(refYear - candYear) <= 3) {
        score += 5;
      }
      const sharedTags = referenceTarget.tags.filter((t) =>
        target.tags.includes(t),
      );
      if (sharedTags.length > 0) {
        score += sharedTags.length * 5;
        reasons.push(`Shared tags: ${sharedTags.slice(0, 3).join(", ")}`);
      }
      if (score > 0) {
        scored.push({ ...target, matchScore: score, matchReasons: reasons });
      }
    }
    scored.sort((a, b) => b.matchScore - a.matchScore);
    return {
      referenceTitle: referenceTarget.title,
      relatedPapers: scored.slice(0, limit),
    };
  }

  async detectDuplicatesInLibrary(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    totalGroups: number;
    groups: DuplicateGroup[];
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const limit =
      Number.isFinite(params.limit) && (params.limit as number) > 0
        ? Math.floor(params.limit as number)
        : 20;
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const byDoi = new Map<string, LibraryPaperTarget[]>();
    const byNormalizedTitle = new Map<string, LibraryPaperTarget[]>();
    for (const candidateId of orderedGatewayPaperIds(snapshot)) {
      const item = this.resolveBibliographicItem(this.getItem(candidateId));
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (!target) continue;
      const doi = normalizeText(
        String(item.getField?.("DOI") ?? ""),
      ).toLowerCase();
      if (doi) {
        const existing = byDoi.get(doi) || [];
        existing.push(target);
        byDoi.set(doi, existing);
      }
      const normalizedTitle = normalizeText(target.title)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (normalizedTitle.length > 10) {
        const existing = byNormalizedTitle.get(normalizedTitle) || [];
        existing.push(target);
        byNormalizedTitle.set(normalizedTitle, existing);
      }
    }
    const groups: DuplicateGroup[] = [];
    const seenItemIds = new Set<number>();
    for (const [doi, papers] of byDoi) {
      if (papers.length < 2) continue;
      if (groups.length >= limit) break;
      const newPapers = papers.filter((p) => !seenItemIds.has(p.itemId));
      if (newPapers.length < 2) continue;
      groups.push({ matchReason: `Same DOI: ${doi}`, papers: newPapers });
      for (const p of newPapers) seenItemIds.add(p.itemId);
    }
    for (const [, papers] of byNormalizedTitle) {
      if (papers.length < 2) continue;
      if (groups.length >= limit) break;
      const newPapers = papers.filter((p) => !seenItemIds.has(p.itemId));
      if (newPapers.length < 2) continue;
      groups.push({ matchReason: "Same title", papers: newPapers });
      for (const p of newPapers) seenItemIds.add(p.itemId);
    }
    return { totalGroups: groups.length, groups };
  }

  async updateArticleMetadata(params: {
    item: Zotero.Item | null;
    metadata: EditableArticleMetadataPatch;
  }): Promise<{
    status: "updated";
    itemId: number;
    title: string;
    changedFields: string[];
  }> {
    // resolveRegularItem silently substitutes the PARENT for a child
    // attachment, so writing metadata on an attachment edited a different
    // object and then read the parent back as confirmation -- a self-verifying
    // false success. The matrix answers per kind instead.
    const resolution = resolveMatrixItem(
      params.item,
      Number(params.item?.id) || 0,
      "update",
    );
    if ("refusal" in resolution) throw new Error(resolution.refusal);
    const item = resolution.item;

    // Every key in the patch is a candidate now. The 18-name allowlist was
    // never the real schema -- Zotero's own field table is -- and it silently
    // dropped anything outside it, so "set the publisher on this book"
    // reported success with nothing written.
    const fieldNames = Object.keys(params.metadata).filter(
      (fieldName) => fieldName !== "creators",
    );
    const unsupportedFields = fieldNames.filter(
      (fieldName) => !isFieldValidForItemType(item, fieldName),
    );
    if (unsupportedFields.length) {
      const itemTypeName = getItemTypeName(item) || "this item type";
      const available = listEditableFieldsForItem(item);
      throw new Error(
        `Unsupported metadata fields for ${itemTypeName}: ${unsupportedFields.join(", ")}.` +
          (available.length
            ? ` Fields this item type accepts: ${available.join(", ")}.`
            : ""),
      );
    }

    const rejectedFields: string[] = [];
    for (const fieldName of fieldNames) {
      const value =
        (params.metadata as Record<string, unknown>)[fieldName] ?? "";
      // setField returns false rather than throwing for a value it cannot
      // parse -- `accessDate: "yesterday"` is the common case -- and the old
      // code ignored that and reported success anyway.
      // The bundled typings declare setField as void; Zotero returns a
      // boolean (item.js:653), false meaning the value was not taken.
      const accepted = (
        item as unknown as {
          setField: (field: string, value: string) => boolean | void;
        }
      ).setField(fieldName, String(value));
      if (accepted === false && String(value).trim()) {
        const before = normalizeText(item.getField?.(fieldName));
        if (before !== String(value).trim()) rejectedFields.push(fieldName);
      }
    }
    if (rejectedFields.length) {
      throw new Error(
        `Zotero rejected these values: ${rejectedFields.join(", ")}. Check the format — dates must be real dates, not phrases like "yesterday".`,
      );
    }

    if (Array.isArray(params.metadata.creators)) {
      const creatorTypes = (
        Zotero as unknown as {
          CreatorTypes?: {
            itemTypeHasCreators?: (itemTypeId: number) => boolean;
          };
        }
      ).CreatorTypes;
      const supportsCreators =
        typeof creatorTypes?.itemTypeHasCreators === "function"
          ? creatorTypes.itemTypeHasCreators(item.itemTypeID)
          : true;
      if (!supportsCreators) {
        const itemTypeName = getItemTypeName(item) || "this item type";
        throw new Error(`Creators are not supported for ${itemTypeName}`);
      }
      item.setCreators(
        params.metadata.creators as Array<
          _ZoteroTypes.Item.CreatorJSON | _ZoteroTypes.Item.Creator
        >,
        { strict: true },
      );
    }

    await item.saveTx();
    const changedFields = [
      ...fieldNames,
      ...(Array.isArray(params.metadata.creators) ? ["creators"] : []),
    ];
    const snapshot = this.getEditableArticleMetadata(item);
    return {
      status: "updated",
      itemId: item.id,
      title: snapshot?.title || `Item ${item.id}`,
      changedFields,
    };
  }

  async trashItems(params: { itemIds: number[] }): Promise<{
    trashedCount: number;
    items: Array<{
      itemId: number;
      title: string;
      status: "trashed" | "skipped" | "error";
      reason?: string;
    }>;
  }> {
    const items: Array<{
      itemId: number;
      title: string;
      status: "trashed" | "skipped" | "error";
      reason?: string;
    }> = [];
    let trashedCount = 0;
    for (const itemId of params.itemIds) {
      const item = this.getItem(itemId);
      if (!item) {
        items.push({
          itemId,
          title: `Item ${itemId}`,
          status: "skipped",
          reason: "Item not found",
        });
        continue;
      }
      const title = String(item.getField?.("title") || `Item ${itemId}`);
      if (item.deleted) {
        items.push({
          itemId,
          title,
          status: "skipped",
          reason: "Already in trash",
        });
        continue;
      }
      try {
        item.deleted = true;
        await item.saveTx();
        trashedCount++;
        items.push({ itemId, title, status: "trashed" });
      } catch (error) {
        items.push({
          itemId,
          title,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { trashedCount, items };
  }

  /**
   * Brings items back out of the trash.
   *
   * Reports which ids it actually restored, rather than `void`: an item that
   * was never trashed is skipped, so a caller that assumed every requested id
   * came back would build an inverse that re-trashes items this call never
   * touched.
   */
  async restoreItems(params: {
    itemIds: number[];
  }): Promise<{ restoredCount: number; itemIds: number[] }> {
    const restored: number[] = [];
    for (const itemId of params.itemIds) {
      const item = this.getItem(itemId);
      if (!item || !item.deleted) continue;
      item.deleted = false;
      await item.saveTx();
      restored.push(Number(item.id));
    }
    return { restoredCount: restored.length, itemIds: restored };
  }

  /** See `CollectionCapability.restoreSavedSearches`. */
  async restoreSavedSearches(params: {
    savedSearchIds: number[];
  }): Promise<{ restoredCount: number; savedSearchIds: number[] }> {
    return this.collectionCapability.restoreSavedSearches(params);
  }

  // ── Merge duplicates ──────────────────────────────────────────────

  /**
   * Merges duplicates, delegating to Zotero's own merge.
   *
   * This used to be hand-rolled, and diverged from Zotero in ways that
   * quietly damaged the library:
   *
   * - It never wrote the `dc:replaces` relation onto the survivor.
   *   `integration.js` resolves a Word or LibreOffice citation pointing at a
   *   merged-away item *only* through that predicate, so on the next citation
   *   refresh the user got "the item could not be found in your library" and
   *   had to hand-pick a replacement for every affected citation. Zotero's
   *   own merge repoints them silently.
   * - It never deduplicated identical PDF attachments by hash, so the
   *   survivor accumulated a copy of the same file per duplicate.
   * - It never remapped old item keys inside merged note HTML
   *   (`Zotero.Notes.replaceItemKey`), leaving dead links in notes.
   * - It never took the earliest `dateAdded`.
   * - It ran outside a transaction, saving each object separately, so a
   *   failure part-way left the library half-merged.
   * - It dropped tag types, turning manual tags into automatic ones.
   *
   * Zotero's implementation does all of this inside one transaction.
   */
  async mergeItems(params: {
    masterItemId: number;
    otherItemIds: number[];
  }): Promise<{
    mergedCount: number;
    masterItemId: number;
    masterTitle: string;
    trashedIds: number[];
  }> {
    const masterItem = this.getItem(params.masterItemId);
    if (!masterItem)
      throw new Error(`Master item ${params.masterItemId} not found`);
    const masterTitle = String(
      masterItem.getField?.("title") || `Item ${params.masterItemId}`,
    );

    const others: Zotero.Item[] = [];
    for (const otherId of params.otherItemIds) {
      if (otherId === params.masterItemId) continue;
      const otherItem = this.getItem(otherId);
      if (!otherItem) continue;
      if (Number(otherItem.libraryID) !== Number(masterItem.libraryID)) {
        throw new Error(
          `Item ${otherId} is in a different library than the master item, and Zotero cannot merge across libraries.`,
        );
      }
      others.push(otherItem);
    }
    if (!others.length) {
      return {
        mergedCount: 0,
        masterItemId: params.masterItemId,
        masterTitle,
        trashedIds: [],
      };
    }

    const merge = (
      Zotero.Items as unknown as {
        merge?: (item: Zotero.Item, otherItems: Zotero.Item[]) => Promise<void>;
      }
    ).merge;
    if (typeof merge !== "function") {
      // Refuse rather than fall back to the hand-rolled path: a merge that
      // silently omits dc:replaces breaks the user's citations, and they
      // would not find out until the next time they refreshed a document.
      throw new Error(
        "This Zotero build does not expose Zotero.Items.merge, so duplicates cannot be merged safely.",
      );
    }
    await merge.call(Zotero.Items, masterItem, others);

    const trashedIds = others.map((item) => Number(item.id));
    return {
      mergedCount: trashedIds.length,
      masterItemId: params.masterItemId,
      masterTitle,
      trashedIds,
    };
  }

  // ── Attachment management ──────────────────────────────────────────

  /**
   * Delete an attachment (moves to trash). See
   * `AttachmentCapability.deleteAttachment`.
   */
  async deleteAttachment(params: { attachmentId: number }): Promise<{
    attachmentId: number;
    title: string;
    status: "deleted" | "not_found";
  }> {
    return this.attachmentCapability.deleteAttachment(params);
  }

  /**
   * Renames an attachment's file on disk. See
   * `AttachmentCapability.renameAttachment`.
   */
  async renameAttachment(params: {
    attachmentId: number;
    newName: string;
  }): Promise<{
    attachmentId: number;
    previousName: string;
    newName: string;
    status: "renamed" | "unchanged" | "not_found" | "no_file" | "error";
    titleUpdated?: boolean;
    reason?: string;
  }> {
    return this.attachmentCapability.renameAttachment(params);
  }

  /**
   * Points an attachment at a different file on disk. See
   * `AttachmentCapability.relinkAttachment`.
   */
  async relinkAttachment(params: {
    attachmentId: number;
    newPath: string;
  }): Promise<{
    attachmentId: number;
    previousPath: string;
    newPath: string;
    status: "relinked" | "not_found" | "not_linked_file" | "error";
    reason?: string;
  }> {
    return this.attachmentCapability.relinkAttachment(params);
  }
  // ── Embed image in note ──────────────────────────────────────────

  /**
   * Import an image file as an embedded note attachment and return its key.
   * The key can then be used in note HTML: <img data-attachment-key="KEY" />
   * See `AttachmentCapability.importNoteImage`.
   */
  async importNoteImage(
    params: NoteImageImportInput,
  ): Promise<{ key: string } | null> {
    return this.attachmentCapability.importNoteImage(params);
  }

  // ── Import local files ──────────────────────────────────────────

  /**
   * Imports a bibliography file (.ris, .bib, ...) through Zotero's
   * translators. See `ImportCapability.importBibliographyFile`.
   */
  async importBibliographyFile(params: {
    filePath: string;
    libraryID: number;
    targetCollectionId?: number;
  }): Promise<{
    status: "imported" | "unsupported" | "error";
    itemIds: number[];
    reason?: string;
  }> {
    return this.importCapability.importBibliographyFile(params);
  }

  /**
   * Import local files (PDFs, bibliography files, ...) into the Zotero
   * library. See `ImportCapability.importLocalFiles`.
   */
  async importLocalFiles(params: {
    filePaths: string[];
    libraryID?: number;
    targetCollectionId?: number;
    /**
     * `translate` reads bibliography files through Zotero's translators,
     * `attach` stores the file as an attachment, `auto` picks by extension.
     */
    mode?: "auto" | "translate" | "attach";
    /** Run Zotero's PDF metadata recognition on imported PDFs. */
    recognize?: boolean;
  }): Promise<{
    succeeded: number;
    failed: number;
    items: Array<{
      filePath: string;
      status: "imported" | "error" | "not_found";
      itemId?: number;
      title?: string;
      reason?: string;
    }>;
  }> {
    return this.importCapability.importLocalFiles(params);
  }

  /**
   * Fetch canonical metadata for a paper by identifier (DOI, arXiv ID or
   * ISBN) without creating an item. See
   * `ImportCapability.fetchMetadataByIdentifier`.
   */
  async fetchMetadataByIdentifier(
    rawIdentifier: string,
  ): Promise<EditableArticleMetadataPatch | null> {
    return this.importCapability.fetchMetadataByIdentifier(rawIdentifier);
  }

  /**
   * Import papers into the Zotero library by identifier. See
   * `ImportCapability.importPapersByIdentifiers`.
   */
  async importPapersByIdentifiers(
    identifiers: string[],
    libraryID?: number,
    targetCollectionId?: number,
  ): Promise<{
    succeeded: number;
    failed: number;
    itemIds?: number[];
    items: Array<{
      identifier: string;
      status: "imported" | "not_found" | "error";
      itemId?: number;
      reason?: string;
    }>;
  }> {
    return this.importCapability.importPapersByIdentifiers(
      identifiers,
      libraryID,
      targetCollectionId,
    );
  }

  /** See `ImportCapability.parseImportIdentifier`. */
  private parseImportIdentifier(rawIdentifier: string): Record<string, string> {
    return this.importCapability.parseImportIdentifier(rawIdentifier);
  }

  /** See `ImportCapability.describeUnresolvableIdentifier`. */
  private describeUnresolvableIdentifier(raw: string): string | null {
    return this.importCapability.describeUnresolvableIdentifier(raw);
  }

  /** See `ImportCapability.translatorJsonToPatch`. */
  private translatorJsonToPatch(
    raw: Record<string, unknown>,
  ): EditableArticleMetadataPatch | null {
    return this.importCapability.translatorJsonToPatch(raw);
  }
}
