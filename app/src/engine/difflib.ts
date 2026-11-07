// Python's difflib.SequenceMatcher(None, a, b).ratio(), for the short strings TV Watch compares (words, a keyword
// against a window of words). No junk and no "popular" pruning: Python only applies that when b has 200+ items.

function longest(a: string, b2j: Map<string, number[]>, alo: number, ahi: number, blo: number, bhi: number) {
  let besti = alo, bestj = blo, bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const next = new Map<number, number>();
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      next.set(j, k);
      if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
    }
    j2len = next;
  }
  return [besti, bestj, bestsize] as const;
}

export function ratio(a: string, b: string) {
  const la = a.length, lb = b.length;
  if (!la && !lb) return 1;
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < lb; j++) {
    const l = b2j.get(b[j]);
    if (l) l.push(j); else b2j.set(b[j], [j]);
  }
  let matches = 0;
  const queue: [number, number, number, number][] = [[0, la, 0, lb]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longest(a, b2j, alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2 * matches) / (la + lb);
}
