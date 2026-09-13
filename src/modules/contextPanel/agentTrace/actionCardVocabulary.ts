import type { AgentActionOperation } from "../../../agent/contracts/types";
import { operationCatalogEntry } from "../../../agent/contracts/operationCatalog";

/**
 * How the action card speaks an operation: an optional glyph, the verb word
 * shown as a tooltip (and inline when the reader turns words on), and whether
 * the glyph is drawn in the destructive colour.
 *
 * A glyph is used only where it says something the object chip cannot: moving
 * (→), adding (+), removing (−), restoring (↺), running (›). Note, file and
 * metadata effects show their chip alone.
 */
export type ActionCardVerb = {
  glyph?: "→" | "+" | "−" | "↺" | "›";
  word: string;
  destructive?: true;
};

export const OPERATION_VERBS = {
  update_metadata: { word: "updated" },
  apply_tags: { glyph: "+", word: "tagged" },
  remove_tags: { glyph: "−", word: "untagged", destructive: true },
  move_to_collection: { glyph: "→", word: "moved to" },
  remove_from_collection: {
    glyph: "−",
    word: "removed from",
    destructive: true,
  },
  create_collection: { glyph: "+", word: "created" },
  set_item_collections: { glyph: "→", word: "set collections" },
  save_notes_batch: { word: "saved notes" },
  save_saved_search: { glyph: "+", word: "saved search" },
  delete_saved_search: {
    glyph: "−",
    word: "deleted search",
    destructive: true,
  },
  update_collection: { word: "updated collection" },
  update_library_tag: { word: "updated tag" },
  set_item_tags: { glyph: "+", word: "set tags" },
  create_items: { glyph: "+", word: "created" },
  reparent_items: { glyph: "→", word: "reparented" },
  relate_items: { glyph: "→", word: "related to" },
  delete_collection: {
    glyph: "−",
    word: "deleted collection",
    destructive: true,
  },
  save_note: { word: "saved note" },
  import_identifiers: { glyph: "+", word: "imported" },
  trash_items: { glyph: "→", word: "moved to", destructive: true },
  restore_from_trash: { glyph: "↺", word: "restored from" },
  merge_items: { glyph: "→", word: "merged into" },
  delete_attachment: {
    glyph: "−",
    word: "deleted attachment",
    destructive: true,
  },
  rename_attachment: { word: "renamed attachment" },
  relink_attachment: { glyph: "→", word: "relinked attachment" },
  import_local_files: { glyph: "+", word: "imported files" },
  note_create: { word: "wrote" },
  note_edit: { word: "edited" },
  note_append: { word: "appended to" },
  annotation_write: { word: "annotated" },
  settings_update: { word: "updated settings" },
  undo: { glyph: "↺", word: "undid" },
  revert: { glyph: "↺", word: "reverted" },
  file_write: { word: "wrote" },
  command_execute: { glyph: "›", word: "ran" },
  zotero_script_execute: { glyph: "›", word: "ran script" },
  read_full: { word: "read" },
} as const satisfies Record<AgentActionOperation, ActionCardVerb>;

/** The verb for an operation, including one this build no longer knows. */
export function operationVerb(operation: string): ActionCardVerb {
  const known = operationCatalogEntry(operation);
  if (known) return OPERATION_VERBS[known.operation];
  return { word: operation.replace(/[_-]+/gu, " ").trim() || "action" };
}
