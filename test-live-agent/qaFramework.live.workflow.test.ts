/** Opt-in native evaluation: authored fixtures, or explicitly approved local paper. */
import { assert } from "chai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  papers,
  cases,
  realPaperCases,
  libraryCases,
} from "../test/fixtures/qaEvaluation/corpus";
import { usageFromResponse } from "../test/helpers/qaUsage";
import {
  measureGrounding,
  measureSupport,
} from "../test/helpers/qaSupportMetrics";
import {
  acquisitionPapers,
  acquisitionCases,
  type AcquisitionCase,
} from "../test/fixtures/qaEvaluation/acquisition";
import { measureAcquisition } from "../test/helpers/qaAcquisitionMetrics";
import { acquisitionRealCases } from "../test/fixtures/qaEvaluation/acquisitionReal";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "../src/services/mineru/mineruCache";
import { resolveLiveAgentCredentials } from "./liveAgentCredentials";
declare const Zotero: any;
declare const IOUtils: any;
declare const Services: any;
const env = (key: string) => String(Services.env.get(key) || "");
const prefix = "extensions.zotero.llmforzotero";
const directory = env("LLM_FOR_ZOTERO_QA_REPORT_DIR");
const realPaper = env("LLM_FOR_ZOTERO_QA_REAL_PAPER") === "1";
const acquisitionOnly = env("LLM_FOR_ZOTERO_QA_SUITE") === "acquisition";
const evaluationCases = realPaper
  ? acquisitionOnly
    ? acquisitionRealCases
    : realPaperCases
  : acquisitionOnly
    ? acquisitionCases
    : [...cases, ...libraryCases];
const variant = env("LLM_FOR_ZOTERO_QA_VARIANT") || "unspecified";
const repeat = Number(env("LLM_FOR_ZOTERO_QA_REPEAT") || 1);
const selected = new Set(
  env("LLM_FOR_ZOTERO_QA_CASES").split(",").filter(Boolean),
);
const clean = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
type EvalCitation = { id: string; quoteText: string; anchorMatch?: string };

/** Quote citations a tool result carries, wherever its payload nests them.
 * Depth-limited and cycle-safe: the content is provider-shaped, not trusted. */
const collectCitations = (content: unknown): EvalCitation[] => {
  const out: EvalCitation[] = [];
  const seen = new Set<unknown>();
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 8 || seen.has(node))
      return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "quoteCitations" && Array.isArray(value)) {
        for (const citation of value)
          if (
            citation &&
            typeof citation === "object" &&
            typeof citation.id === "string" &&
            typeof citation.quoteText === "string"
          )
            out.push(citation as EvalCitation);
        continue;
      }
      visit(value, depth + 1);
    }
  };
  visit(content, 0);
  return out;
};

/** Sections a read actually delivered: flat results, or the per-paper groups. */
const deliveredSectionsOf = (content: any): string[] => {
  const rows: any[] = Array.isArray(content?.results)
    ? content.results
    : [content?.papers, content?.groups]
        .filter(Array.isArray)
        .flatMap((groups: any[]) =>
          groups.flatMap((group: any) =>
            Array.isArray(group?.passages) ? group.passages : [],
          ),
        );
  return [
    ...new Set(
      rows
        .map((row) => row?.sectionPath || row?.sectionLabel)
        .filter(
          (section): section is string =>
            typeof section === "string" && section.length > 0,
        ),
    ),
  ];
};

describe("adaptive QA framework native evaluation", function () {
  this.timeout(360000);
  const refs: any[] = [];
  const created: number[] = [];
  // Collection ids are a separate sequence from item ids, so they are tracked
  // apart: looking one up with Zotero.Items.get could hit an unrelated item.
  const createdCollections: number[] = [];
  let libraryScope: {
    collectionId: number;
    name: string;
    libraryID: number;
  } | null = null;
  let credentials: Awaited<ReturnType<typeof resolveLiveAgentCredentials>>;
  const write = (name: string, data: unknown) =>
    Zotero.File.putContentsAsync(
      `${directory}/${name}`,
      JSON.stringify(data, null, 2),
    );
  before(async function () {
    if (!directory) {
      this.skip();
      return;
    }
    credentials = await resolveLiveAgentCredentials({
      requestedModel: env("LLM_FOR_ZOTERO_LIVE_MODEL") || "deepseek-flash",
    });
    assert.isOk(
      credentials,
      "Configured live credentials must be available; requested evaluation cannot silently skip",
    );
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      ignoreExisting: true,
    });
    Zotero.Prefs.set(`${prefix}.mineruGlobalAutoParse`, false, true);
    Zotero.Prefs.set(`${prefix}.mineruSyncEnabled`, false, true);
    Zotero.Prefs.set(`${prefix}.mineruEnabled`, true, true);
    // Fixed lexical setting isolates harness cost from first-time remote indexing.
    Zotero.Prefs.set(`${prefix}.enableSemanticSearch`, false, true);
    const sources = realPaper
      ? [
          {
            id: "peschka",
            title:
              "Numerics of thin-film free boundary problems for partial wetting",
            author: "Peschka",
            year: "2014",
            text: String(
              await Zotero.File.getContentsAsync(
                `${env("LLM_FOR_ZOTERO_LIVE_PAPER_CACHE")}/full.md`,
              ),
            ),
          },
        ]
      : acquisitionOnly
        ? acquisitionPapers
        : papers;
    for (const source of sources) {
      const item = new Zotero.Item("journalArticle");
      item.libraryID = Zotero.Libraries.userLibraryID;
      item.setField("title", source.title);
      item.setField("date", source.year);
      item.setCreators([
        {
          creatorType: "author",
          firstName: "Evaluation",
          lastName: source.author,
        },
      ]);
      const itemId = Number(await item.saveTx());
      created.push(itemId);
      let path = env("LLM_FOR_ZOTERO_LIVE_PAPER_PDF");
      if (!realPaper) {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        for (const section of source.text.split(/\n\n(?=## )/)) {
          const page = doc.addPage([612, 792]);
          let y = 745;
          for (const paragraph of section.split("\n")) {
            const words = paragraph.split(/\s+/);
            let line = "";
            for (const word of words) {
              if ((line + word).length > 85) {
                page.drawText(line, { x: 35, y, size: 10, font });
                y -= 15;
                line = "";
              }
              line += word + " ";
            }
            if (line) {
              page.drawText(line, { x: 35, y, size: 10, font });
              y -= 20;
            }
          }
        }
        path = `${directory}/${source.id}.pdf`;
        await IOUtils.write(path, await doc.save());
      }
      const attachment = await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID: itemId,
        contentType: "application/pdf",
      });
      created.push(attachment.id);
      await writeMineruCacheFiles(attachment.id, source.text, [
        {
          relativePath: "full.md",
          data: new TextEncoder().encode(source.text),
        },
      ]);
      await writeMineruSourceProvenanceForAttachment(attachment);
      refs.push({
        libraryID: item.libraryID,
        itemId,
        contextItemId: attachment.id,
        title: source.title,
        firstCreator: source.author,
        year: source.year,
      });
    }
    if (!realPaper && !acquisitionOnly) {
      // Library-chat cases need a collection scope rather than an active paper.
      const collection = new Zotero.Collection();
      collection.libraryID = Zotero.Libraries.userLibraryID;
      collection.name = `QA evaluation collection ${variant}-${repeat}`;
      const collectionId = Number(await collection.saveTx());
      createdCollections.push(collectionId);
      await collection.addItems(
        created.filter((id) => Zotero.Items.get(id)?.isRegularItem()),
      );
      libraryScope = {
        collectionId,
        name: collection.name,
        libraryID: collection.libraryID,
      };
    }
    await write(`setup-${variant}-${repeat}${realPaper ? "-real" : ""}.json`, {
      variant,
      repeat,
      build: env("LLM_FOR_ZOTERO_QA_BUILD"),
      profile: Services.dirsvc.get("ProfD", Components.interfaces.nsIFile).path,
      dataDirectory: Zotero.DataDirectory.dir,
      model: credentials!.model,
      sourceType: realPaper
        ? "real paper with existing extraction"
        : "authored fictional fixtures",
      semanticSearch: false,
      suite: acquisitionOnly ? "acquisition" : "framework",
      refs,
    });
  });
  after(async function () {
    for (const id of [...created].reverse()) {
      const item = Zotero.Items.get(id);
      if (item) await item.eraseTx();
    }
    for (const id of [...createdCollections].reverse()) {
      const collection = Zotero.Collections.get(id);
      if (collection) await collection.eraseTx();
    }
  });
  for (const entry of evaluationCases.filter(
    (c) => !selected.size || selected.has(c.id),
  )) {
    it(`${entry.id} ${entry.category}: ${entry.question}`, async function () {
      const libraryCase = "library" in entry && Boolean(entry.library);
      const toolkit = Zotero.LLMForZotero.data.ztoolkit;
      const original = toolkit.getGlobal;
      const fetch = original.call(toolkit, "fetch");
      const requests: any[] = [];
      const pending: Promise<void>[] = [];
      const events: any[] = [];
      const start = Date.now();
      toolkit.getGlobal = function (name: string) {
        if (name !== "fetch") return original.call(toolkit, name);
        return async (url: string, init?: RequestInit) => {
          let body: any;
          try {
            body = JSON.parse(String(init?.body || "{}"));
          } catch {
            body = {};
          }
          const measured = Boolean(
            body.model || body.messages || body.input || body.contents,
          );
          const record: any = {
            index: requests.length,
            kind: /embed/i.test(url)
              ? "embedding"
              : body.tools?.length
                ? "agent"
                : "utility",
            model: body.model || null,
            startedMs: Date.now() - start,
          };
          if (measured) requests.push(record);
          try {
            const response = await fetch(url, init);
            if (measured) {
              record.status = response.status;
              pending.push(
                response
                  .clone()
                  .text()
                  .then((text: string) => {
                    record.elapsedMs = Date.now() - start - record.startedMs;
                    record.usage = usageFromResponse(text);
                  })
                  .catch(() => {
                    record.usage = null;
                    record.captureError = true;
                  }),
              );
            }
            return response;
          } catch (error) {
            record.failed = true;
            record.elapsedMs = Date.now() - start - record.startedMs;
            throw error;
          }
        };
      };
      let result: any;
      let error: string | undefined;
      try {
        result = await Zotero.LLMForZotero.api.agent.runTurn(
          {
            conversationKey:
              Math.floor(Date.now() / 10) + evaluationCases.indexOf(entry),
            mode: "agent",
            libraryID: refs[0].libraryID,
            // A library case has no active paper: the collection is the scope.
            ...(libraryCase
              ? {
                  conversationKind: "global",
                  selectedCollectionContexts: libraryScope
                    ? [libraryScope]
                    : [],
                  selectedPaperContexts: [],
                }
              : {
                  conversationKind: "paper",
                  activeItemId: refs[0].itemId,
                  activePaperContext: refs[0],
                  selectedPaperContexts: entry.multi ? refs : [],
                }),
            ...credentials,
            ...("history" in entry ? { history: entry.history } : {}),
            ...(entry.id === "p4"
              ? {
                  history: [
                    {
                      role: "user",
                      content:
                        "Does a finite contact angle explain the pressure-gradient singularity?",
                    },
                    {
                      role: "assistant",
                      content:
                        "Yes. A finite nonzero contact angle necessarily forces the third derivative of the height profile, and therefore the pressure gradient, to diverge.",
                    },
                  ],
                }
              : {}),
            userText: `${entry.question}\n\nUse the supplied context and selected evaluation papers only. Do not use external sources or modify the library. Keep the answer concise.${entry.provided ? `\n\n[Provided context]\n${entry.provided}` : ""}`,
          },
          (event: any) => {
            if (
              [
                "tool_call",
                "tool_result",
                "message_rollback",
                "usage",
                "final",
                "done",
                "error",
              ].includes(event.type)
            )
              events.push({ ...event, atMs: Date.now() - start });
            if (event.type === "confirmation_required")
              void Zotero.LLMForZotero.api.agent.resolveConfirmation(
                event.requestId,
                false,
              );
          },
        );
      } catch (e) {
        error = String(e);
      } finally {
        toolkit.getGlobal = original;
        await Promise.all(pending);
      }
      const delivered = events
        .filter((e) => e.type === "tool_result")
        .map((e) => JSON.stringify(e.content || {}))
        .join("\n");
      const calls = events.filter((e) => e.type === "tool_call");
      const usage = requests.map((r) => r.usage).filter(Boolean);
      const answer = String(result?.text || "");
      // The answer's own citations when the turn carries them; otherwise the
      // ones the tools delivered, so a baseline run is still scored.
      const finalEvent = events.find((e) => e.type === "final");
      const finalQuoteCitations: EvalCitation[] = Array.isArray(
        finalEvent?.quoteCitations,
      )
        ? finalEvent.quoteCitations
        : [];
      const toolQuoteCitations = events
        .filter((e) => e.type === "tool_result" && e.ok)
        .flatMap((e) => collectCitations(e.content));
      const citations = finalQuoteCitations.length
        ? finalQuoteCitations
        : toolQuoteCitations;
      const report = {
        variant,
        repeat,
        id: entry.id,
        category: entry.category,
        question: entry.question,
        rubric: entry.rubric,
        provided: entry.provided,
        ...("history" in entry ? { history: entry.history } : {}),
        sourceEvidence: entry.evidence,
        scope: libraryCase ? "library" : "paper",
        outcome: result?.kind,
        error,
        answer,
        elapsedMs: Date.now() - start,
        support: measureSupport(answer, citations),
        grounding: measureGrounding(
          answer,
          new Set(citations.map((c) => c.id)),
        ),
        finalQuoteCitations: finalQuoteCitations.length,
        deliveredSections: events
          .filter((e) => e.type === "tool_result" && e.name === "paper_read")
          .map((e) => ({
            callId: e.callId,
            sections: deliveredSectionsOf(e.content),
          })),
        acquisition: acquisitionOnly
          ? measureAcquisition(
              entry as AcquisitionCase,
              events,
              refs,
              realPaper ? [{ id: "peschka" }] : acquisitionPapers,
            )
          : {
              required: entry.evidence.length,
              found: entry.evidence.filter((s) =>
                clean(delivered).includes(clean(s)),
              ).length,
              reads: calls.filter((e) => e.name === "paper_read").length,
            },
        synthesis: {
          assessment: "source-based review required",
          candidate: answer,
        },
        verification: {
          assessment:
            entry.category === "verification"
              ? "seeded error or correct-control review required"
              : "final support review required",
          rollbacks: events.filter((e) => e.type === "message_rollback").length,
        },
        provider: {
          requests: requests.length,
          unknownUsage: requests.filter(
            (r) => !r.usage || r.usage.totalTokens === null,
          ).length,
          totalTokens: usage.reduce((s, u) => s + (u.totalTokens || 0), 0),
        },
        requests,
        events,
      };
      await write(`${variant}-${repeat}-${entry.id}.json`, report);
      assert.equal(
        result?.kind,
        "completed",
        error || result?.reason || "must complete",
      );
      assert.isNotEmpty(report.answer, "must retain a final answer");
      assert.isAbove(
        requests.length,
        0,
        "provider capture must observe requests",
      );
    });
  }
});
