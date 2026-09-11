export type ContextSelectionAdapter = {
  getActiveAttachment: () => Zotero.Item | null;
  resolveContextItem: (item: Zotero.Item) => Zotero.Item | null;
};

let activeAdapter: ContextSelectionAdapter | null = null;

export function configureContextSelectionBridge(
  adapter: ContextSelectionAdapter | null,
): () => void {
  const previous = activeAdapter;
  activeAdapter = adapter;
  return () => {
    if (activeAdapter === adapter) activeAdapter = previous;
  };
}

export function getSelectedContextAttachment(): Zotero.Item | null {
  return activeAdapter?.getActiveAttachment() || null;
}

export function resolveSelectedContextItem(
  item: Zotero.Item,
): Zotero.Item | null {
  return activeAdapter?.resolveContextItem(item) || null;
}
