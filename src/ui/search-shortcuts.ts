export type SearchShortcutContext = {
  searchOpen: boolean;
  targetIsInside: boolean;
  openSearch(): void;
  closeSearch(): void;
};

export function handleSearchShortcutEvent(
  context: SearchShortcutContext,
  event: KeyboardEvent,
): boolean {
  if (event.type !== "keydown" || !context.targetIsInside) return false;
  if (event.key === "Escape" && context.searchOpen) {
    event.preventDefault();
    event.stopImmediatePropagation();
    context.closeSearch();
    return true;
  }
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== "f"
    || (!event.metaKey && !event.ctrlKey)) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  context.openSearch();
  return true;
}
