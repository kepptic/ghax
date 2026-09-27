/**
 * Daemon-wide ref numbering, shared by both transports.
 *
 * Invariant: a printed ref (`@e12`, `@c3`) is NEVER reused for a different
 * element during a daemon's lifetime. Stable refs made numbers reusable in
 * dangerous ways: after a navigation a fresh document starts its own
 * numbering (Playwright restarts `e<n>`; the bridge identity map reset to
 * e1; the page-side cursor registry restarts at 1), so a plan written against
 * page A's `@e5` could land on page B's `@e5`. Here every element gets its
 * number from one monotonic counter per prefix, keyed by (document id,
 * transport key), and `docOf` remembers which document a ref was minted on so
 * a caller can refuse a ref from a page that is gone.
 *
 * Transport keys: `b<backendNodeId>` (bridge AX), `p<playwright ref>` (CDP
 * aria-ref, e.g. `pf3e6`), `k<cursorId>` (bridge cursor registry),
 * `s<selector>` (CDP cursor chain).
 */

export type RefPrefix = 'e' | 'c';

export interface RefAllocator {
  /** Number for this element; reused while role and name are unchanged. */
  assign(prefix: RefPrefix, key: string, role: string, name: string): string;
  /** Forget this document's keys not in `alive`, and every other document's. */
  prune(alive: Set<string>): void;
}

/** Bound on `docOf` so a long-lived daemon doesn't grow without limit. */
const DOC_OF_CAP = 50_000;

export class RefRegistry {
  private next: Record<RefPrefix, number> = { e: 1, c: 1 };
  private byKey = new Map<string, { ref: string; role: string; name: string }>();
  private docOfRef = new Map<string, string>();

  forDoc(docId: string): RefAllocator {
    return {
      assign: (prefix, key, role, name) => {
        const k = `${docId}|${prefix}|${key}`;
        const known = this.byKey.get(k);
        if (known && known.role === role && known.name === name) return known.ref;
        const ref = `${prefix}${this.next[prefix]++}`;
        this.byKey.set(k, { ref, role, name });
        this.docOfRef.set(ref, docId);
        if (this.docOfRef.size > DOC_OF_CAP) {
          const oldest = this.docOfRef.keys().next().value;
          if (oldest !== undefined) this.docOfRef.delete(oldest);
        }
        return ref;
      },
      prune: (alive) => {
        const mine = `${docId}|`;
        for (const k of this.byKey.keys()) {
          if (!k.startsWith(mine)) {
            this.byKey.delete(k);
            continue;
          }
          const key = k.slice(k.indexOf('|', mine.length) + 1);
          if (!alive.has(key)) this.byKey.delete(k);
        }
      },
    };
  }

  /** The document a ref was minted on, if it is still remembered. */
  docOf(ref: string): string | undefined {
    return this.docOfRef.get(ref);
  }

  /**
   * Tab change / navigation: forget element identities, KEEP the counters
   * and `docOf`, so no number is ever handed out twice.
   */
  clear(): void {
    this.byKey.clear();
  }

  /** Test hook: how many identities are held. */
  get size(): number {
    return this.byKey.size;
  }
}

/** The per-document id inside a freshness marker (`docId|mut|href`). */
export function docIdOfMarker(marker: string | null): string | null {
  if (!marker) return null;
  const i = marker.indexOf('|');
  return i > 0 ? marker.slice(0, i) : null;
}
