import { createElement } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import { config } from "./constants";
import { closeDedicatedChatPane } from "./dedicatedChatPane";

export function createDockedPanelTitle(body: Element): HTMLElement {
  const doc = body.ownerDocument;
  const row = createElement(doc, "div", "llm-docked-title-row");
  const brand = createElement(doc, "div", "llm-docked-brand");
  brand.append(
    createElement(doc, "img", "llm-docked-logo", {
      src: `chrome://${config.addonRef}/content/icons/icon-sidebar.svg`,
      alt: "",
    }),
    createElement(doc, "span", "", { textContent: "LLM-for-Zotero" }),
  );
  const close = createElement(doc, "button", "llm-docked-close", {
    type: "button",
    title: t("Close"),
  });
  close.setAttribute("aria-label", t("Close"));
  close.addEventListener("click", () => closeDedicatedChatPane(body));
  row.append(brand, close);
  return row;
}
