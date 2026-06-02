/** Compare dotted numeric versions (major.minor.patch). Any `-prerelease` suffix
 *  is ignored for ordering — the host only ships release versions. Returns -1/0/1.
 *  Non-numeric or missing segments are treated as 0, so a stale/garbage version
 *  (e.g. '0.0.0' or '') sorts below any real release. */
export function cmpSemver(a: string, b: string): number {
  const parse = (s: string): number[] =>
    (s ?? '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
