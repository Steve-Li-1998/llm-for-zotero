import type { GeneratedChatImage } from "../../shared/types";
import type { CreatedZoteroNoteReceipt } from "../notePersistence";

export type AssistantNoteWriteResult = {
  status: "created" | "appended" | "standalone_created";
  noteId?: number;
  collections?: number[];
  createdNoteReceipt?: CreatedZoteroNoteReceipt;
};

export type AssistantItemNoteWrite = {
  item: Zotero.Item;
  content: string;
  modelName: string;
  appendToTrackedNote?: boolean;
  generatedImages?: GeneratedChatImage[];
};

export type AssistantStandaloneNoteWrite = {
  libraryID: number;
  content: string;
  modelName: string;
  generatedImages?: GeneratedChatImage[];
  collections?: number[];
};

export type AssistantNoteWriter = {
  writeItemNote: (
    params: AssistantItemNoteWrite,
  ) => Promise<AssistantNoteWriteResult>;
  writeStandaloneNote: (
    params: AssistantStandaloneNoteWrite,
  ) => Promise<AssistantNoteWriteResult>;
};

let activeWriter: AssistantNoteWriter | null = null;

export function configureAssistantNoteWriter(
  writer: AssistantNoteWriter | null,
): () => void {
  const previous = activeWriter;
  activeWriter = writer;
  return () => {
    if (activeWriter === writer) activeWriter = previous;
  };
}

function requireWriter(): AssistantNoteWriter {
  if (!activeWriter) {
    throw new Error(
      "The formatted assistant-note writer is not configured for this application surface.",
    );
  }
  return activeWriter;
}

export function writeAssistantItemNote(
  params: AssistantItemNoteWrite,
): Promise<AssistantNoteWriteResult> {
  return requireWriter().writeItemNote(params);
}

export function writeAssistantStandaloneNote(
  params: AssistantStandaloneNoteWrite,
): Promise<AssistantNoteWriteResult> {
  return requireWriter().writeStandaloneNote(params);
}
