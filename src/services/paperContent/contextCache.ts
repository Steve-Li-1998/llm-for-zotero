import { TTLMap } from "../../utils/ttlMap";
import type { PdfContext } from "./types";

// Sized above multi-paper retrieval caps so a folder or tag synthesis does not
// evict source text while its evidence pack is still being assembled.
export const pdfTextCache = new TTLMap<number, PdfContext>(30 * 60 * 1000, 100);
export const pdfTextLoadingTasks = new Map<number, Promise<void>>();
