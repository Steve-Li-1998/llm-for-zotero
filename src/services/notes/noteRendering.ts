import { renderMarkdownForNote } from "../../utils/markdown";
import { escapeNoteHtml, sanitizeText } from "../../utils/textSanitization";
import {
  decodeNoteHtmlEntities,
  stripNoteHtml,
  stripNoteMarkup,
} from "../../utils/noteText";

export function isLikelyHtmlNoteContent(text: string): boolean {
  if (!text || !/[<>]/.test(text)) return false;
  return /<\/?(?:p|div|span|strong|b|em|i|u|a|ul|ol|li|blockquote|h[1-6]|br|hr|code|pre)\b/i.test(
    text,
  );
}

export function normalizeNoteSourceText(contentText: string): string {
  const raw = sanitizeText(contentText || "").trim();
  if (!raw) return "";
  if (!isLikelyHtmlNoteContent(raw)) return raw;
  return decodeNoteHtmlEntities(noteHtmlToMarkdown(raw)) || stripNoteHtml(raw);
}

/** Compose first; decode entities once at the public HTML-to-text boundary. */
function noteHtmlToMarkdown(raw: string): string {
  let normalized = raw.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  const quote =
    /<blockquote\b[^>]*>((?:(?!<\/?blockquote\b)[\s\S])*)<\/blockquote>/gi;
  while (/<blockquote\b/i.test(normalized)) {
    const next = normalized.replace(
      quote,
      (_match, body: string) =>
        `\n\n${noteHtmlToMarkdown(body)
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n")}\n\n`,
    );
    if (next === normalized) break;
    normalized = next;
  }

  normalized = normalized.replace(
    /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote, href, text) => {
      const label = stripNoteMarkup(text).trim();
      const target = `${href || ""}`.trim();
      if (!label) return target;
      return target ? `[${label}](${target})` : label;
    },
  );
  normalized = normalized.replace(
    /<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tag, text) => `**${stripNoteMarkup(text).trim()}**`,
  );
  normalized = normalized.replace(
    /<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_match, _tag, text) => `*${stripNoteMarkup(text).trim()}*`,
  );
  normalized = normalized.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_match, text) => `\`${stripNoteMarkup(text).trim()}\``,
  );
  normalized = normalized.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_match, text) => `\n\n\`\`\`\n${stripNoteMarkup(text)}\n\`\`\`\n\n`,
  );
  normalized = normalized.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  normalized = normalized.replace(/<br\s*\/?>/gi, "\n");
  normalized = normalized.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match, level, text) =>
      `\n\n${"#".repeat(Number(level) || 1)} ${stripNoteMarkup(text).trim()}\n\n`,
  );
  normalized = normalized.replace(/<li[^>]*>/gi, "\n- ");
  normalized = normalized.replace(/<\/li>/gi, "");
  normalized = normalized.replace(
    /<\/?(?:p|div|section|article)\b[^>]*>/gi,
    "\n\n",
  );
  normalized = normalized.replace(/<(?!img\b)[^>]+>/g, "");
  return normalized
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderRawNoteHtml(contentText: string): string {
  const raw = normalizeNoteSourceText(contentText);
  if (!raw) return "<p></p>";
  try {
    return renderMarkdownForNote(raw);
  } catch (error) {
    ztoolkit.log("Note markdown render error:", error);
    return escapeNoteHtml(raw).replace(/\n/g, "<br/>");
  }
}

export function appendNoteHtml(
  existingHtml: string,
  newAnswerHtml: string,
): string {
  const base = (existingHtml || "").trim();
  const addition = (newAnswerHtml || "").trim();
  if (!base) return addition;
  if (!addition) return base;
  const schema = base.match(
    /^(<div\b[^>]*\bdata-schema-version=[^>]*>)([\s\S]*)<\/div>$/i,
  );
  if (schema) {
    return `${schema[1]}${schema[2].trim()}\n<hr>\n${addition}\n</div>`;
  }
  return `${base}<hr/>${addition}`;
}
