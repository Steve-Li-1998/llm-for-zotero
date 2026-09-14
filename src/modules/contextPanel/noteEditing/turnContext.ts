import type { ActiveNoteContext, PaperContextRef } from "../../../shared/types";
import type { NoteEditingScope } from "../../../services/notes/scope";

export type NoteEditingTurnContext = {
  activeNoteContext?: ActiveNoteContext;
  autoLoadedPaperContext?: PaperContextRef | null;
};

export function buildNoteEditingTurnContext(params: {
  scope: NoteEditingScope | null;
  snapshot?: { text?: string; html?: string } | null;
  autoLoadedPaperContext?: PaperContextRef | null;
}): NoteEditingTurnContext {
  const scope = params.scope;
  if (!scope) return {};
  return {
    activeNoteContext: {
      noteId: scope.noteId,
      title: scope.title,
      noteKind: scope.noteKind,
      parentItemId: scope.parentItemId,
      noteText: params.snapshot?.text || "",
      noteHtml: params.snapshot?.html,
    },
    autoLoadedPaperContext: params.autoLoadedPaperContext || null,
  };
}
