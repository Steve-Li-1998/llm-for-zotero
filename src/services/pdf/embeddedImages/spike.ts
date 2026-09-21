import { imageObjectToCanvas, type PdfjsImageObject } from "./imageObject";
import {
  PDFJS_DOCUMENT_OPTIONS,
  resolvePdfjsImageObject,
  tryPdfjsStrategies,
} from "./pdfjsLoader";

export type PdfImageSpikeReport = {
  strategy?: string;
  strategyErrors: Record<string, string>;
  pdfjsVersion?: string;
  filePath?: string;
  numPages?: number;
  pages: Array<{
    pageNumber: number;
    imageDraws: number;
    firstImage?: {
      objId: string;
      width?: number;
      height?: number;
      shape: "bitmap" | "data" | "unresolved" | "unknown";
      kind?: number;
      pngBytes?: number;
    };
    textItems: number;
    sampleText: string[];
  }>;
  error?: string;
};

/**
 * Temporary diagnostic for the pdf.js feasibility check. Run in Zotero:
 * Tools → Developer → Run JavaScript (as async function):
 *   return JSON.stringify(await Zotero.LLMForZotero.api.pdfImageSpike(<attachmentID>), null, 2)
 */
export async function runPdfImageSpike(
  attachmentId: number,
  maxPages = 5,
): Promise<PdfImageSpikeReport> {
  const report: PdfImageSpikeReport = { strategyErrors: {}, pages: [] };
  try {
    const { loaded, errors } = await tryPdfjsStrategies();
    report.strategyErrors = errors;
    if (!loaded) throw new Error("no strategy loaded pdf.js");
    report.strategy = loaded.strategy;
    report.pdfjsVersion = loaded.pdfjs.version;

    const item = Zotero.Items.get(attachmentId);
    const path = await (
      item as unknown as { getFilePathAsync?: () => Promise<string | false> }
    ).getFilePathAsync?.();
    if (!path) throw new Error("attachment has no local file");
    report.filePath = path;
    const bytes = await IOUtils.read(path);

    const doc = await loaded.pdfjs.getDocument({
      data: bytes,
      ...PDFJS_DOCUMENT_OPTIONS,
    }).promise;
    report.numPages = doc.numPages;
    const paintImage = loaded.pdfjs.OPS.paintImageXObject;
    const win = Zotero.getMainWindow();
    try {
      for (let n = 1; n <= Math.min(maxPages, doc.numPages); n += 1) {
        const page = await doc.getPage(n);
        const opList = await page.getOperatorList();
        const imageArgs = opList.fnArray
          .map((fn, index) =>
            fn === paintImage ? opList.argsArray[index] : null,
          )
          .filter(Boolean) as unknown[][];
        const text = await page.getTextContent();
        const entry: PdfImageSpikeReport["pages"][number] = {
          pageNumber: n,
          imageDraws: imageArgs.length,
          textItems: text.items.length,
          sampleText: text.items
            .map((item) => item.str || "")
            .filter(Boolean)
            .slice(0, 3),
        };
        const objId = imageArgs[0]?.[0];
        if (typeof objId === "string") {
          const obj = resolvePdfjsImageObject(
            page,
            objId,
          ) as PdfjsImageObject | null;
          const shape = !obj
            ? "unresolved"
            : obj.bitmap
              ? "bitmap"
              : obj.data
                ? "data"
                : "unknown";
          const canvas = obj ? imageObjectToCanvas(win.document, obj) : null;
          entry.firstImage = {
            objId,
            width: obj?.width,
            height: obj?.height,
            shape,
            kind: obj?.kind,
            pngBytes: canvas?.toDataURL("image/png").length,
          };
        }
        report.pages.push(entry);
        page.cleanup?.();
      }
    } finally {
      await doc.destroy?.();
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
}
