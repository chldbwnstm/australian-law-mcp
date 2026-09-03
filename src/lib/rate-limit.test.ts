import { describe, it, expect } from "vitest"
import { createTokenBucket, createDailyCap } from "./rate-limit.js"

const T0 = 1_700_000_000_000

describe("createTokenBucket", () => {
  it("passes the bucket capacity immediately and denies the next one", () => {
    const b = createTokenBucket(60, 60)
    for (let i = 0; i < 60; i++) expect(b.take(1, T0).ok).toBe(true)
    const denied = b.take(1, T0)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterSec).toBe(1) // 60rpm = one token per second
  })

  it("passes again as tokens refill (unlike a fixed window, no waiting for the window edge)", () => {
    const b = createTokenBucket(60, 60)
    for (let i = 0; i < 60; i++) b.take(1, T0)
    expect(b.take(1, T0 + 999).ok).toBe(false)   // under a second → not yet
    expect(b.take(1, T0 + 5_000).ok).toBe(true)  // 5 seconds → 5 refilled
    expect(b.take(4, T0 + 5_000).ok).toBe(true)
    expect(b.take(1, T0 + 5_000).ok).toBe(false)
  })

  it("never refills past the bucket capacity", () => {
    const b = createTokenBucket(60, 60)
    b.take(60, T0)
    b.take(60, T0 + 3_600_000) // even an idle hour only fills to capacity
    expect(b.take(1, T0 + 3_600_000).ok).toBe(false)
  })

  it("deducts a batch of n in one call", () => {
    const b = createTokenBucket(120, 120)
    expect(b.take(100, T0).ok).toBe(true)
    expect(b.take(21, T0).ok).toBe(false)
    expect(b.take(20, T0).ok).toBe(true)
  })

  it("denies a request larger than the capacity with a finite advised wait", () => {
    const b = createTokenBucket(60, 60)
    const v = b.take(1000, T0)
    expect(v.ok).toBe(false)
    expect(v.retryAfterSec).toBeGreaterThan(0)
    expect(Number.isFinite(v.retryAfterSec)).toBe(true)
  })

  it("rate 0 means the fallback is disabled — deny everything", () => {
    const b = createTokenBucket(0)
    expect(b.take(1, T0).ok).toBe(false)
  })

  it("a burst larger than the rate absorbs a bigger initial burst", () => {
    const b = createTokenBucket(60, 180)
    expect(b.take(180, T0).ok).toBe(true)
    expect(b.take(1, T0).ok).toBe(false)
  })
})

describe("createDailyCap", () => {
  it("limit 0 means no cap", () => {
    const c = createDailyCap(0)
    expect(c.take(1_000_000, T0).ok).toBe(true)
    expect(c.used(T0)).toBe(0)
  })

  it("passes up to the limit and denies the excess", () => {
    const c = createDailyCap(100)
    expect(c.take(99, T0).ok).toBe(true)
    expect(c.take(1, T0).ok).toBe(true)
    const denied = c.take(1, T0)
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterSec).toBeGreaterThan(0)
    expect(c.used(T0)).toBe(100)
  })

  it("a denied request consumes none of the allowance", () => {
    const c = createDailyCap(10)
    c.take(10, T0)
    c.take(5, T0)
    expect(c.used(T0)).toBe(10)
  })

  it("resets the window after 24 hours", () => {
    const c = createDailyCap(10)
    c.take(10, T0)
    expect(c.take(1, T0 + 86_399_000).ok).toBe(false)
    expect(c.take(1, T0 + 86_400_001).ok).toBe(true)
  })
})
