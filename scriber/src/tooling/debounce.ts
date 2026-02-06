export type DebounceCallbacks<T> = {
  onStart: (payload: T) => void | Promise<void>;
  onFlush: (payload: T) => void | Promise<void>;
};

export class InputDebouncer<T> {
  private delayMs: number;
  private callbacks: DebounceCallbacks<T>;
  private timer: NodeJS.Timeout | null = null;
  private pending: T | null = null;

  constructor(delayMs: number, callbacks: DebounceCallbacks<T>) {
    this.delayMs = delayMs;
    this.callbacks = callbacks;
  }

  async push(payload: T) {
    if (!this.pending) {
      this.pending = payload;
      await this.callbacks.onStart(payload);
    } else {
      this.pending = payload;
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.delayMs);
  }

  getPending() {
    return this.pending;
  }

  async flush() {
    if (!this.pending) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const payload = this.pending;
    this.pending = null;
    this.timer = null;
    await this.callbacks.onFlush(payload);
  }

  get hasPending() {
    return this.pending !== null;
  }
}
