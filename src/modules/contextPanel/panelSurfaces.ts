/**
 * Composition root for the seams that live entirely inside the panel -- one
 * panel module depending on another through a bridge, with no `src/services/**`
 * half.
 *
 * This is deliberately separate from `hostSurfaces.ts`, and must stay separate:
 * it imports the chat renderer, and the chat renderer transitively imports the
 * agent skill markdown (`src/agent/skills/*.md`). The workflow test bundler in
 * zotero-plugin-scaffold hardcodes its esbuild options with no `.md` loader, so
 * any module a workflow bundle reaches must stay clear of the renderer, and
 * every workflow bundle reaches `hostSurfaces.ts` through
 * `test-workflows/hostSurfaceBootstrap.ts`. Folding this composition back into
 * `hostSurfaces.ts` breaks the entire workflow suite at build time -- it is
 * pinned by `test/workflowBundleImports.test.ts`.
 *
 * Like the host-surface composition, this runs once from plugin startup rather
 * than as a side effect of importing a UI module, so that whether a capability
 * is available depends on the plugin being started, not on import order.
 */
import { refreshChat } from "./chat";
import { configureQuoteValidationChatRefresher } from "./quoteValidation/chatRefreshBridge";

/**
 * Configures every panel-internal bridge and returns a disposer that undoes the
 * whole composition, in reverse order, on plugin shutdown.
 */
export function composePanelSurfaces(): () => void {
  const disposers = [
    // The background quote validator repaints the messages it changed; only
    // the chat renderer can do that, and it imports the validator, so the
    // dependency is composed here rather than registered at import time.
    configureQuoteValidationChatRefresher(refreshChat),
  ];
  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}
