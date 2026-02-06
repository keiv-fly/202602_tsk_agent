import { describe, expect, it, vi } from "vitest";

import { InputDebouncer } from "../src/tooling/debounce.js";

describe("input debouncing", () => {
  it("coalesces input events within the inactivity window", async () => {
    vi.useFakeTimers();
    const startCalls: number[] = [];
    const flushCalls: number[] = [];

    const debouncer = new InputDebouncer<number>(200, {
      onStart: async (payload) => {
        startCalls.push(payload);
      },
      onFlush: async (payload) => {
        flushCalls.push(payload);
      }
    });

    await debouncer.push(1);
    await debouncer.push(2);
    await debouncer.push(3);

    expect(startCalls).toEqual([1]);
    expect(flushCalls).toEqual([]);

    vi.advanceTimersByTime(200);
    await Promise.resolve();

    expect(flushCalls).toEqual([3]);
    vi.useRealTimers();
  });
});
