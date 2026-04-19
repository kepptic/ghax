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

const SM_COMMENT_RE = /\/\/[#@]\s*sourceMappingURL=([^\s]+)/g;

/**
 * Cache of parsed consumers keyed by the bundled script URL. `null` means
 * "tried, failed, don't retry" so we don't keep hammering an unreachable
 * or mapless script.
 */
export class SourceMapCache {
  private cache = new Map<string, SourceMapConsumer | null | Promise<SourceMapConsumer | null>>();

  async get(scriptUrl: string, fetchImpl: typeof fetch = fetch): Promise<SourceMapConsumer | null> {
    const cached = this.cache.get(scriptUrl);
    if (cached !== undefined) {
      return cached instanceof Promise ? await cached : cached;
    }
    const promise = this.resolve(scriptUrl, fetchImpl);
    this.cache.set(scriptUrl, promise);
    const result = await promise;
    this.cache.set(scriptUrl, result);
    return result;
  }

  private async resolve(scriptUrl: string, fetchImpl: typeof fetch): Promise<SourceMapConsumer | null> {
    try {
      const resp = await fetchImpl(scriptUrl, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) return null;
      const body = await resp.text();
      // Find the LAST sourceMappingURL comment (some bundlers emit multiple
      // chunk comments; the final one is authoritative).
      let mapUrl: string | null = null;
      const matches = body.matchAll(SM_COMMENT_RE);
      for (const m of matches) mapUrl = m[1];
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
