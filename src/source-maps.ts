/**
 * Source-map resolution for console error stack frames.
 *
 * Given a bundled `{url, line, col}` frame, fetch the script, find its
 * sourceMappingURL (either inline as a comment at the bottom of the file or
 * as a data: URI), parse the map, and resolve the position back to the
 * original source. Cache parsed maps so we don't re-parse on every frame.
 *
 * All failure modes fall back silently to the original frame — if we can't
 * map, callers see the bundled position, no worse than before. That's the
 * contract: source-map resolution is a best-effort enhancement, never
 * required for correctness.
 */

import { SourceMapConsumer } from 'source-map';
import type { StackFrame } from './buffers';

// Cap on cached consumers. Each holds ~100KB-few MB of wasm memory; 50
// entries covers even large SPAs (typical apps ship 5-20 chunks). Past
// the cap, oldest entries get destroy()'d and evicted. Prevents
// unbounded growth on long-running daemons.
const CACHE_MAX = 50;

/**
 * Cache of parsed consumers keyed by the bundled script URL.
 *   - `null`    → tried, no map available, don't retry
 *   - Promise   → fetch + parse in flight; concurrent callers share it
 *   - Consumer  → resolved and reusable
 *
 * LRU by Map insertion order — touched entries move to the end on read.
 */
export class SourceMapCache {
  private cache = new Map<string, SourceMapConsumer | null | Promise<SourceMapConsumer | null>>();

  async get(scriptUrl: string, fetchImpl: typeof fetch = fetch): Promise<SourceMapConsumer | null> {
    const cached = this.cache.get(scriptUrl);
    if (cached !== undefined) {
      // LRU touch — move to newest slot without eviction.
      this.cache.delete(scriptUrl);
      this.cache.set(scriptUrl, cached);
      return cached instanceof Promise ? await cached : cached;
    }
    const promise = this.resolve(scriptUrl, fetchImpl);
    this.insert(scriptUrl, promise);
    const result = await promise;
    this.insert(scriptUrl, result);
    return result;
  }

  private insert(key: string, value: SourceMapConsumer | null | Promise<SourceMapConsumer | null>): void {
    this.cache.set(key, value);
    while (this.cache.size > CACHE_MAX) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.cache.get(oldestKey);
      if (oldest && !(oldest instanceof Promise)) {
        try {
          oldest.destroy();
        } catch {
          // ignore
        }
      }
      this.cache.delete(oldestKey);
    }
  }

  private async resolve(scriptUrl: string, fetchImpl: typeof fetch): Promise<SourceMapConsumer | null> {
    try {
      const resp = await fetchImpl(scriptUrl, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) return null;
      const body = await resp.text();
      // Find the LAST sourceMappingURL comment. Bundlers can emit multiple
      // chunk comments per file; the final one is authoritative. lastIndexOf
      // + a single non-global regex is simpler than the matchAll-and-take-
      // last approach, and avoids the global-regex statefulness gotcha.
      const lastAt = body.lastIndexOf('sourceMappingURL=');
      if (lastAt < 0) return null;
      const match = body.slice(lastAt).match(/sourceMappingURL=([^\s]+)/);
      const mapUrl = match ? match[1] : null;
      if (!mapUrl) return null;

      let mapJson: string;
      if (mapUrl.startsWith('data:')) {
        // data:application/json;base64,XXXX — strip everything before the comma,
        // base64-decode if that's the encoding.
        const comma = mapUrl.indexOf(',');
        if (comma < 0) return null;
        const header = mapUrl.slice(0, comma);
        const payload = mapUrl.slice(comma + 1);
        mapJson = header.includes(';base64')
          ? Buffer.from(payload, 'base64').toString('utf-8')
          : decodeURIComponent(payload);
      } else {
        // Relative or absolute URL — resolve against the script URL.
        const abs = new URL(mapUrl, scriptUrl).toString();
        const mapResp = await fetchImpl(abs, { signal: AbortSignal.timeout(3000) });
        if (!mapResp.ok) return null;
        mapJson = await mapResp.text();
      }
      return await new SourceMapConsumer(mapJson);
    } catch {
      return null;
    }
  }

  async resolveFrame(frame: StackFrame): Promise<StackFrame> {
    if (!frame.url || frame.line == null || frame.col == null) return frame;
    // Only bother for http(s) URLs. Chrome-extension:// and similar don't
    // typically ship maps in a reachable form.
    if (!/^https?:/i.test(frame.url)) return frame;

    const consumer = await this.get(frame.url);
    if (!consumer) return frame;
    const original = consumer.originalPositionFor({ line: frame.line, column: frame.col });
    if (!original.source || original.line == null) return frame;

    return {
      fn: original.name ?? frame.fn,
      url: original.source,
      line: original.line,
      col: original.column ?? 0,
      bundledUrl: frame.url,
      bundledLine: frame.line,
      bundledCol: frame.col,
    };
  }

  /**
   * Destroy cached consumers. SourceMapConsumer holds wasm memory; calling
   * destroy() on each is recommended but not strictly required in short-lived
   * processes. Daemon shutdown calls this during teardown.
   */
  destroy(): void {
    for (const v of this.cache.values()) {
      if (v && !(v instanceof Promise)) {
        try {
          v.destroy();
        } catch {
          // ignore
        }
      }
    }
    this.cache.clear();
  }
}

/**
 * Resolve a list of frames in parallel, preserving order. Frames that can't
 * be mapped come back unchanged.
 */
export async function resolveStack(
  cache: SourceMapCache,
  frames: StackFrame[],
): Promise<StackFrame[]> {
  return Promise.all(frames.map((f) => cache.resolveFrame(f)));
}
