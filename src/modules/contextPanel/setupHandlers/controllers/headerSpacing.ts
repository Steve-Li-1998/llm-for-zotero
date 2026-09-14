/** Reclaim only the runtime group's empty space, and only when it is needed. */
export function updateHeaderSpacing(header: HTMLElement | null): void {
  if (!header || !header.getBoundingClientRect().width) return;
  const runtime = header.querySelector<HTMLElement>(
    ".llm-header-runtime-controls",
  );
  const actions = header.querySelector<HTMLElement>(".llm-header-actions");
  if (!runtime || !actions) return;

  // Measure the original spacing on every pass so widening restores it fully.
  header.style.setProperty("--llm-runtime-compression", "0");
  const buttons = (
    Array.from(
      runtime.querySelectorAll(".llm-runtime-system-toggle"),
    ) as HTMLElement[]
  ).filter((button) => button.getBoundingClientRect().width > 0);
  if (!buttons.length) return;
  const gap =
    parseFloat(
      header.ownerDocument.defaultView?.getComputedStyle(header)?.columnGap ||
        "0",
    ) || 0;
  const shortage =
    runtime.getBoundingClientRect().right +
    gap -
    actions.getBoundingClientRect().left;
  // Each button can give up 6px; the group and chip gaps contribute 2px and 4px.
  const available = buttons.length * 6 + (buttons.length - 1) * 2 + 4;
  header.style.setProperty(
    "--llm-runtime-compression",
    String(Math.min(1, Math.max(0, shortage / available))),
  );
}
