/**
 * Shared composition point for capabilities that only an application surface
 * (the Zotero panel, a window, a test harness) can provide.
 *
 * Services and agent code must never import `src/modules/**`, so a host
 * surface injects the concrete implementation at startup and the rest of the
 * codebase depends on this narrow contract instead. A bridge is deliberately
 * loud: code that reaches a capability on a surface that never composed it is
 * a wiring bug, not a runtime condition to degrade around.
 */
export type SurfaceBridge<T> = {
  /**
   * Installs `adapter` as the capability for the running surface and returns a
   * disposer that restores whatever was configured before. A disposer that has
   * already been superseded by a later `configure` is a no-op, so shutdown
   * order cannot clobber a newer adapter.
   */
  configure: (adapter: T | null) => () => void;
  /** The configured adapter, or a thrown error naming the missing bridge. */
  require: () => T;
  /** The configured adapter, or `null` on an uncomposed surface. */
  current: () => T | null;
};

export function createSurfaceBridge<T>(name: string): SurfaceBridge<T> {
  let activeAdapter: T | null = null;
  return {
    configure(adapter) {
      const previous = activeAdapter;
      activeAdapter = adapter;
      return () => {
        if (activeAdapter === adapter) activeAdapter = previous;
      };
    },
    require() {
      if (!activeAdapter) {
        throw new Error(
          `The ${name} adapter is not configured for this application surface.`,
        );
      }
      return activeAdapter;
    },
    current() {
      return activeAdapter;
    },
  };
}
