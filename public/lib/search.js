/**
 * createSearch — lightweight search engine for multiple item registries.
 *
 * Usage:
 *   const search = createSearch();
 *   search.register('characters', () => characters.map(c => ({
 *     id: c.id, label: c.name, sublabel: c.description?.slice(0, 80),
 *     icon: c.avatar, category: 'Characters', action: () => openEditor(c.id),
 *   })));
 *   const results = search.query('chas');
 *   // → [{ category: 'Characters', items: [{ label: 'Chasity', ... }] }]
 */
export function createSearch() {
  const registries = new Map(); // category → () => items[]

  function register(category, fn) {
    registries.set(category, fn);
  }

  function query(term) {
    const t = (term ?? '').trim().toLowerCase();
    const results = [];

    for (const [category, fn] of registries) {
      let items;
      try { items = fn(); } catch { continue; }

      let scored;
      if (!t) {
        // No query — return all items unscored (up to cap)
        scored = items.map(item => ({ item, score: 0 }));
      } else {
        scored = [];
        for (const item of items) {
          const label    = (item.label    ?? '').toLowerCase();
          const sublabel = (item.sublabel  ?? '').toLowerCase();
          const keywords = (item.keywords  ?? '').toLowerCase();
          let score = 0;
          if (label.startsWith(t))           score = 3;
          else if (label.includes(t))        score = 2;
          else if (sublabel.includes(t))     score = 1;
          else if (keywords.includes(t))     score = 1;
          if (score > 0) scored.push({ item, score });
        }
        scored.sort((a, b) => b.score - a.score);
      }

      const capped = scored.slice(0, 8).map(s => s.item);
      if (capped.length > 0) results.push({ category, items: capped });
    }

    return results;
  }

  return { register, query };
}
