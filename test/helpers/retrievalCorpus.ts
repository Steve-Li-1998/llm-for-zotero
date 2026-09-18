/**
 * Synthetic retrieval corpus fixtures.
 *
 * The fixtures are invented prose that mirrors the *structure* of real papers
 * (a `##`-heading maths paper and a `#`-heading life-science paper). They exist
 * so the retrieval benchmark can measure section labelling and ranking on a
 * stable, offline corpus. No real paper text is stored in this repository.
 *
 * The in-memory `IOUtils` / `Zotero` stubs are copies of the ones in
 * `test/pdfContext.multiContext.test.ts` (that file keeps its own copies).
 */
import fs from "node:fs";
import path from "node:path";
import { writeMineruCacheFiles } from "../../src/services/mineru/mineruCache";
import { ensurePDFTextCached } from "../../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../../src/services/paperContent/contextCache";
import type { PdfContext } from "../../src/services/paperContent/types";

const encoder = new TextEncoder();

export type MemoryIO = {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  writes: string[];
};

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

function parentPath(filePath: string): string {
  const normalized = normalizePath(filePath);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function addDir(dirs: Set<string>, dirPath: string): void {
  let current = normalizePath(dirPath);
  const ancestors: string[] = [];
  while (current && current !== "/") {
    ancestors.push(current);
    current = parentPath(current);
  }
  ancestors.push("/");
  for (const dir of ancestors.reverse()) dirs.add(dir);
}

export function setupMemoryIO(): MemoryIO {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const writes: string[] = [];
  addDir(dirs, "/tmp/zotero");

  const io = {
    exists: async (filePath: string) => {
      const normalized = normalizePath(filePath);
      return files.has(normalized) || dirs.has(normalized);
    },
    read: async (filePath: string) => {
      const normalized = normalizePath(filePath);
      const data = files.get(normalized);
      if (!data) throw new Error(`Missing file: ${filePath}`);
      return data;
    },
    makeDirectory: async (filePath: string) => {
      addDir(dirs, filePath);
    },
    write: async (filePath: string, data: Uint8Array) => {
      const normalized = normalizePath(filePath);
      addDir(dirs, parentPath(normalized));
      files.set(normalized, data);
      writes.push(normalized);
    },
    remove: async (filePath: string) => {
      const normalized = normalizePath(filePath);
      for (const key of [...files.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          files.delete(key);
        }
      }
      for (const key of [...dirs.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) {
          dirs.delete(key);
        }
      }
    },
    getChildren: async (filePath: string) => {
      const normalized = normalizePath(filePath);
      const prefix = normalized === "/" ? "/" : `${normalized}/`;
      const children = new Set<string>();
      for (const key of [...dirs, ...files.keys()]) {
        if (!key.startsWith(prefix) || key === normalized) continue;
        const rest = key.slice(prefix.length);
        const childName = rest.split("/")[0];
        if (childName) children.add(`${prefix}${childName}`);
      }
      return [...children];
    },
  };

  (globalThis as unknown as { IOUtils: typeof io }).IOUtils = io;
  return { files, dirs, writes };
}

export function setupZoteroGlobals(parentTitle = "Mock MinerU Paper"): void {
  const parentItem = {
    getField: (field: string) => (field === "title" ? parentTitle : ""),
  };
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    DataDirectory: { dir: "/tmp/zotero" },
    Profile: { dir: "/tmp/profile" },
    Prefs: {
      get: (key: string) => (key.endsWith(".mineruEnabled") ? true : undefined),
      set: () => {},
    },
    Items: {
      get: (id: number) => (id === 100 ? parentItem : null),
    },
    PDFWorker: {
      getFullText: async () => ({ text: "" }),
    },
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    log: () => {},
  };
}

export function mockPdfAttachment(id: number): Zotero.Item {
  return {
    id,
    parentID: 100,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
    getField: (field: string) => (field === "title" ? "PDF" : ""),
  } as unknown as Zotero.Item;
}

export type CorpusName = "mathDoubleHash" | "bioSingleHash";

export function loadRetrievalCorpusFixture(name: CorpusName) {
  const dir = path.join(__dirname, "..", "fixtures", "retrievalCorpus");
  return {
    md: fs.readFileSync(path.join(dir, `${name}.md`), "utf8"),
    contentList: JSON.parse(
      fs.readFileSync(path.join(dir, `${name}.contentList.json`), "utf8"),
    ) as unknown[],
  };
}

export async function buildFixturePdfContext(
  name: CorpusName,
  attachmentId: number,
): Promise<PdfContext> {
  setupMemoryIO();
  setupZoteroGlobals();
  pdfTextCache.clear();
  const { md, contentList } = loadRetrievalCorpusFixture(name);
  await writeMineruCacheFiles(attachmentId, md, [
    { relativePath: "full.md", data: encoder.encode(md) },
    {
      relativePath: "content_list.json",
      data: encoder.encode(JSON.stringify(contentList)),
    },
  ]);
  await ensurePDFTextCached(mockPdfAttachment(attachmentId));
  const context = pdfTextCache.get(attachmentId);
  if (!context) throw new Error("fixture context not built");
  return context;
}
