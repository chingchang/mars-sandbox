// Builds run one at a time. The smoke test judges a module by the worst
// single tick on the wall clock (2 ms, a sandbox guarantee), so a build that
// shares the CPU with another compile or smoke test can be rejected for a
// false reason and the model told to fix working code. Serialising builds
// makes a build's result independent of what else the server is doing. The
// queue is bounded: one running plus `maxWaiting` waiting; beyond that a
// caller is told the workshop is busy instead of piling up.
export class BusyError extends Error {
  constructor(message = "the workshop is busy, try again in a moment") { super(message); }
}

export class BuildQueue {
  readonly maxWaiting: number;
  running = 0;
  waiting = 0;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(maxWaiting = 4) { this.maxWaiting = maxWaiting; }
  /** One running plus the waiting ones. */
  get inFlight(): number { return this.running + this.waiting; }
  /** Room for one more, counting the one that may be running. */
  get hasRoom(): boolean { return this.inFlight < 1 + this.maxWaiting; }
  /** Run fn after every build queued before it has finished. Throws BusyError at once if the queue is full. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.hasRoom) throw new BusyError();
    this.waiting++;
    const before = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>(r => { release = r; });
    try {
      await before;
      this.waiting--; this.running++;
      try { return await fn(); } finally { this.running--; }
    } finally { release(); }
  }
}
