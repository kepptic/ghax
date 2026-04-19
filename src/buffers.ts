/**
 * CircularBuffer<T> — O(1) insert, fixed-capacity ring buffer.
 *
 * Adapted from gstack/browse/src/buffers.ts (MIT — Garry Tan).
 *
 * Used for console + network + dialog rolling windows. Reads return
 * entries in insertion order (oldest first) or the last N.
 */

export class CircularBuffer<T> {
  private buffer: (T | undefined)[];
  private head: number = 0;
  private _size: number = 0;
  private _totalAdded: number = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(entry: T): void {
    const index = (this.head + this._size) % this.capacity;
    this.buffer[index] = entry;
    if (this._size < this.capacity) {
      this._size++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
    this._totalAdded++;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this._size; i++) {
      out.push(this.buffer[(this.head + i) % this.capacity] as T);
    }
    return out;
  }

  last(n: number): T[] {
    const count = Math.min(n, this._size);
    const out: T[] = [];
    const start = (this.head + this._size - count) % this.capacity;
    for (let i = 0; i < count; i++) {
      out.push(this.buffer[(start + i) % this.capacity] as T);
    }
    return out;
  }

  filter(pred: (v: T) => boolean): T[] {
    return this.toArray().filter(pred);
  }

  get length(): number {
    return this._size;
  }

  get totalAdded(): number {
    return this._totalAdded;
  }

  clear(): void {
    this.head = 0;
    this._size = 0;
  }
}

export interface StackFrame {
  fn: string | null;  // function name, or null for anonymous
  url: string;        // file/script URL
  line: number;
  col: number;
}

export interface ConsoleEntry {
  timestamp: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';
  text: string;
  url?: string;
  source?: 'tab' | 'service_worker' | 'sidepanel' | 'popup' | 'options';
  targetId?: string;
  stack?: StackFrame[];  // parsed stack trace, present on pageerror entries
}

/**
 * Parse a V8-style stack trace string into structured frames.
 * Handles:
 *   at fn (url:line:col)          → { fn, url, line, col }
 *   at fn [as alias] (url:line:col)
 *   at async fn (url:line:col)    → fn stripped of "async "
 *   at url:line:col                → { fn: null, url, line, col }
 * The leading "Error: message" line (and any non-frame lines) is skipped.
 */
export function parseStack(stack: string | undefined | null): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const rawLine of stack.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('at ')) continue;
    const body = line.slice(3);
    // at fn (url:line:col)
    let m = body.match(/^(.+?)\s+\((.+?):(\d+):(\d+)\)$/);
    if (m) {
      const fn = m[1].replace(/^async\s+/, '').trim();
      frames.push({
        fn: fn.length > 0 ? fn : null,
        url: m[2],
        line: Number(m[3]),
        col: Number(m[4]),
      });
      continue;
    }
    // at url:line:col (anonymous)
    m = body.match(/^(.+?):(\d+):(\d+)$/);
    if (m) {
      frames.push({ fn: null, url: m[1], line: Number(m[2]), col: Number(m[3]) });
    }
  }
  return frames;
}

export interface NetworkEntry {
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  duration?: number;
  size?: number;
  resourceType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  responseAt?: number;  // timestamp response arrived (for duration calc)
}
