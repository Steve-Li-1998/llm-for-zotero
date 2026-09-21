import { appLogger } from "../../../core/logging";

export const PDFJS_MODULE_URL = "resource://zotero/reader/pdf/build/pdf.mjs";
export const PDFJS_WORKER_URL =
  "resource://zotero/reader/pdf/build/pdf.worker.mjs";

export type PdfjsObjectPool = {
  has?: (id: string) => boolean;
  get: (id: string) => unknown;
};

export type PdfjsTextItem = {
  str?: string;
  transform?: ArrayLike<number>;
  width?: number;
  height?: number;
};

export type PdfjsPage = {
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  getTextContent: () => Promise<{ items: PdfjsTextItem[] }>;
  objs: PdfjsObjectPool;
  commonObjs: PdfjsObjectPool;
  cleanup?: () => void;
};

export type PdfjsDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfjsPage>;
  destroy?: () => Promise<void>;
};

export type PdfjsModule = {
  version?: string;
  OPS: Record<string, number>;
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (source: Record<string, unknown>) => {
    promise: Promise<PdfjsDocument>;
  };
};

export type PdfjsLoadStrategy = "main-window-import" | "chrome-utils";

export type LoadedPdfjs = { pdfjs: PdfjsModule; strategy: PdfjsLoadStrategy };

/** Options that keep pdf.js from touching fonts or OffscreenCanvas. */
export const PDFJS_DOCUMENT_OPTIONS = {
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  disableFontFace: true,
  isEvalSupported: false,
  useWorkerFetch: false,
};

let loading: Promise<LoadedPdfjs> | null = null;

function isPdfjsModule(value: unknown): value is PdfjsModule {
  const mod = value as Partial<PdfjsModule> | null;
  return Boolean(
    mod &&
    typeof mod.getDocument === "function" &&
    mod.OPS &&
    mod.GlobalWorkerOptions,
  );
}

async function importViaMainWindow(): Promise<unknown> {
  const win = Zotero.getMainWindow?.() as
    | (Window & { eval?: (code: string) => unknown })
    | undefined;
  if (!win?.eval) throw new Error("Zotero main window is unavailable");
  // Evaluated in the window realm: the plugin bundle itself never contains
  // import() syntax, which the subscript sandbox may reject at parse time.
  return await (win.eval(
    `import(${JSON.stringify(PDFJS_MODULE_URL)})`,
  ) as Promise<unknown>);
}

async function importViaChromeUtils(): Promise<unknown> {
  const chromeUtils = (
    globalThis as {
      ChromeUtils?: { importESModule?: (url: string) => unknown };
    }
  ).ChromeUtils;
  if (!chromeUtils?.importESModule) {
    throw new Error("ChromeUtils.importESModule is unavailable");
  }
  return chromeUtils.importESModule(PDFJS_MODULE_URL);
}

const STRATEGIES: Array<[PdfjsLoadStrategy, () => Promise<unknown>]> = [
  ["main-window-import", importViaMainWindow],
  ["chrome-utils", importViaChromeUtils],
];

/** Tries every strategy in order; reports each failure for diagnostics. */
export async function tryPdfjsStrategies(): Promise<{
  loaded?: LoadedPdfjs;
  errors: Record<string, string>;
}> {
  const errors: Record<string, string> = {};
  for (const [strategy, load] of STRATEGIES) {
    try {
      const mod = await load();
      if (!isPdfjsModule(mod)) {
        errors[strategy] = "module lacks getDocument/OPS/GlobalWorkerOptions";
        continue;
      }
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return { loaded: { pdfjs: mod, strategy }, errors };
    } catch (error) {
      errors[strategy] = error instanceof Error ? error.message : String(error);
    }
  }
  return { errors };
}

export function loadPdfjs(): Promise<LoadedPdfjs> {
  if (!loading) {
    const attempt = tryPdfjsStrategies().then(({ loaded, errors }) => {
      if (loaded) return loaded;
      appLogger.warn("[Embedded images] pdf.js could not be loaded", errors);
      throw new Error(`pdf.js could not be loaded: ${JSON.stringify(errors)}`);
    });
    loading = attempt;
    attempt.catch(() => {
      if (loading === attempt) loading = null;
    });
  }
  return loading;
}

/** Looks an image object up in the page pool, then the shared pool. */
export function resolvePdfjsImageObject(
  page: PdfjsPage,
  objId: string,
): unknown {
  const pools = objId.startsWith("g_")
    ? [page.commonObjs, page.objs]
    : [page.objs, page.commonObjs];
  for (const pool of pools) {
    try {
      if (!pool) continue;
      if (typeof pool.has === "function" && !pool.has(objId)) continue;
      const value = pool.get(objId);
      if (value) return value;
    } catch {
      // pdf.js throws when the object is not resolved in this pool.
    }
  }
  return null;
}
