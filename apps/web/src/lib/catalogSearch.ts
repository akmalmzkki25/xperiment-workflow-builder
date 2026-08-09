/**
 * Palette search.
 *
 * Every field is read as OPTIONAL on purpose. The connector catalog does not carry
 * display names or descriptions yet; when it does, search improves on its own, and
 * until then it falls back to matching the type — today's behaviour. That is what
 * makes this independent of the catalog-metadata work rather than blocked on it.
 */

export interface SearchableItem {
  type: string;
  kind?: string | undefined;
  displayName?: string | undefined;
  description?: string | undefined;
  category?: string | undefined;
}

function haystack(item: SearchableItem): string {
  return [item.type, item.kind, item.displayName, item.description, item.category]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * Tokenised AND: every word must appear somewhere.
 *
 * So "send whats" finds whatsapp.sendMessage, which a single substring match over the
 * raw type would miss — nobody types a connector id with the dot in the right place.
 */
export function matchesQuery(item: SearchableItem, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  const text = haystack(item);
  return tokens.every((token) => text.includes(token));
}

export function filterCatalog<T extends SearchableItem>(items: readonly T[], query: string): T[] {
  if (query.trim().length === 0) return [...items];
  return items.filter((item) => matchesQuery(item, query));
}
