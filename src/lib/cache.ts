/**
 * Simple in-memory cache for law data.
 * Caches frequently requested records so upstream calls are not repeated.
 */

interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number // time to live in milliseconds
}

/** Search results move often enough to expire hourly. */
export const SEARCH_CACHE_TTL = 60 * 60 * 1000
/** Article/section text is near-static between amendments — hold it a day. */
export const ARTICLE_CACHE_TTL = 24 * 60 * 60 * 1000

export class SimpleCache {
  private cache: Map<string, CacheEntry<any>>
  private maxSize: number

  constructor(maxSize: number = 100) {
    this.cache = new Map()
    this.maxSize = maxSize
  }

  set<T>(key: string, data: T, ttl: number = ARTICLE_CACHE_TTL): void {
    // TTL default: 24 hours

    // If cache is full, evict expired entries first, then oldest
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictOne()
    }

    // Re-inserting an existing key moves it to the end of the Map (LRU order)
    this.cache.delete(key)
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    })
  }

  /** Drop an expired entry first; if none is expired, drop the LRU (oldest). */
  private evictOne(): void {
    const now = Date.now()
    // First pass: find and remove an expired entry
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key)
        return
      }
    }
    // Second pass: nothing expired, so remove the first (oldest) key in Map order
    const oldestKey = this.cache.keys().next().value
    if (oldestKey) {
      this.cache.delete(oldestKey)
    }
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key)

    if (!entry) {
      return null
    }

    // Check if expired
    const now = Date.now()
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return null
    }

    // LRU promotion: move to the end of Map order
    this.cache.delete(key)
    this.cache.set(key, entry)

    return entry.data as T
  }

  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false

    // Check if expired
    const now = Date.now()
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return false
    }

    return true
  }

  delete(key: string): void {
    this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }

  // Clean up expired entries
  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key)
      }
    }
  }
}

// Global cache instance.
// Dozens of tools × many query combinations mean maxSize=100 would evict
// constantly. Legislation text changes rarely, so hit rates are high and a
// generous ceiling pays for itself.
export const lawCache = new SimpleCache(500)

// Cleanup expired entries every hour
setInterval(() => {
  lawCache.cleanup()
}, 60 * 60 * 1000).unref()
