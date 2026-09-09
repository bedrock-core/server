/**
 * The scheduler behind `batch()`.
 *
 * Notification is synchronous by default: a listener runs inside the `set` that changed the
 * value, in the same tick, because a `before` event handler that flips a value must see its
 * listeners run before the event resolves. `batch` is the one place that defers — everything
 * queued inside it is delivered once, at the end, in the order it was queued.
 *
 * A flush is itself a batching window: a listener that sets another observable during delivery
 * queues it behind the current one instead of interleaving, and a `computed` whose dependencies
 * both changed recomputes exactly once. Set iteration visits entries added during the loop, so
 * anything queued mid-flush is delivered in the same synchronous pass.
 */

export interface Flushable {
  flush(): void;
}

let depth = 0;
let flushing = false;
const pending = new Set<Flushable>();

/** Whether a change made now should be queued rather than delivered immediately. */
export function isBatching(): boolean {
  return depth > 0 || flushing;
}

/** Queue a task to run at the end of the current batch. */
export function enqueue(task: Flushable): void {
  pending.add(task);
}

/**
 * Run `fn` and deliver every notification it caused once, afterwards. Nested batches flush at
 * the outermost.
 */
export function batch(fn: () => void): void {
  depth++;

  try {
    fn();
  } finally {
    depth--;

    if (depth === 0 && !flushing) {
      flushPending();
    }
  }
}

function flushPending(): void {
  flushing = true;

  try {
    for (const task of pending) {
      pending.delete(task);
      task.flush();
    }
  } finally {
    flushing = false;
  }
}

/**
 * Wrap `fn` so that, inside a batch, it runs once at flush no matter how many times it is asked
 * to; outside a batch it runs immediately. The unit `computed` and `effect` are built on.
 */
export function coalesced(fn: () => void): () => void {
  const task = {
    queued: false,
    flush(): void {
      task.queued = false;
      fn();
    },
  };

  return (): void => {
    if (!isBatching()) {
      fn();

      return;
    }

    if (!task.queued) {
      task.queued = true;
      enqueue(task);
    }
  };
}
