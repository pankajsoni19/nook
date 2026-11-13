/**
 * A card's estimate as readers see it (D752): hidden (NULL) while its board has estimates off, the
 * stored value kept. One rule for the card selects (service.ts) and the query's `has:estimate` and
 * columns (query.ts); `estimateKind` is the SQL for the card's board's `estimate_kind`, `k` the card.
 */
export const visibleEstimateSql = (estimateKind: string) => `(CASE WHEN ${estimateKind} = 'none' THEN NULL ELSE k.estimate END)`;
