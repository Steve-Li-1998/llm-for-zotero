import { appLogger } from "../../../core/logging";
import { ensureAttachmentBlobFromPath } from "../../../services/attachmentStorage";
import type { RetrievalImageResult } from "../../services/retrievalService";
import type { AgentToolArtifact } from "../../types";

export type RetrievedImageEntry = {
  displayLabel: string;
  /** 1-based. */
  page: number;
  kind: "embedded image" | "figure region";
  label?: string;
  caption?: string;
  similarity: number;
  why: RetrievalImageResult["why"];
};

type DeliveryDeps = {
  persistFromPath: (
    sourcePath: string,
    fileName: string,
  ) => Promise<{ storedPath: string; contentHash: string }>;
};

const DEFAULT_DEPS: DeliveryDeps = {
  persistFromPath: ensureAttachmentBlobFromPath,
};

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "paper"
  );
}

/**
 * Turns selected paper images into model-facing result entries plus image
 * artifacts, which the runtime attaches for models that accept images.
 */
export async function buildRetrievedImageDelivery(
  images: RetrievalImageResult[],
  deps: DeliveryDeps = DEFAULT_DEPS,
): Promise<{
  entries: RetrievedImageEntry[];
  artifacts: AgentToolArtifact[];
}> {
  const entries: RetrievedImageEntry[] = [];
  const artifacts: AgentToolArtifact[] = [];
  for (const image of images) {
    const page = image.pageIndex + 1;
    const kind = image.source === "vector" ? "figure region" : "embedded image";
    const extension = image.mimeType === "image/jpeg" ? "jpg" : "png";
    let persisted: { storedPath: string; contentHash: string };
    try {
      persisted = await deps.persistFromPath(
        image.imagePath,
        `${slug(image.paperContext.title || "paper")}-p${page}-${slug(image.imageId)}.${extension}`,
      );
    } catch (error) {
      appLogger.debug("[Embedded images] Could not deliver an image", error);
      continue;
    }
    entries.push({
      displayLabel: image.sourceLabel,
      page,
      kind,
      ...(image.label ? { label: image.label } : {}),
      ...(image.caption ? { caption: image.caption } : {}),
      similarity: Math.round(image.score * 1000) / 1000,
      why: image.why,
    });
    artifacts.push({
      kind: "image",
      mimeType: image.mimeType,
      storedPath: persisted.storedPath,
      contentHash: persisted.contentHash,
      title: `${image.sourceLabel} — p. ${page} ${kind}${image.label ? ` — ${image.label}` : ""}`,
      pageIndex: image.pageIndex,
      pageLabel: `${page}`,
      paperContext: image.paperContext,
    });
  }
  return { entries, artifacts };
}
