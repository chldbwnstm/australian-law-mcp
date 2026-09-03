/** Bounded, cancellable readers for upstream Fetch responses. */

import { getRequestSignal, requestCancelledError, requestContext, throwIfRequestCancelled } from "./session-state.js"

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length")
  if (!raw || !/^(?:0|[1-9]\d*)$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Give up on a body — **never await this.**
 *
 * `response.clone()` tees the body, and cancelling only one branch of a tee
 * leaves that cancel promise unsettled until the other branch is cancelled too
 * (web streams spec). Awaiting a cleanup cancel therefore hangs forever — that
 * is how an over-limit body turned a tool call into a 300-second timeout
 * instead of an error. Cancellation is cleanup; there is no reason to wait.
 */
function abandonReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => {})
}

function abandonBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (!signal) return reader.read()
  if (signal.aborted) {
    abandonReader(reader)
    throw requestCancelledError(signal.reason)
  }

  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>>((resolve, reject) => {
    const onAbort = () => {
      abandonReader(reader)
      reject(requestCancelledError(signal.reason))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    reader.read().then(
      value => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Consume one upstream body while enforcing the request context's byte
 * budgets.  `Response.text()` and `arrayBuffer()` provide no size hook, so
 * using a reader is what lets cancellation and limits stop work in flight.
 */
export async function readResponseBytes(response: Response): Promise<Uint8Array> {
  throwIfRequestCancelled()
  const budget = requestContext.getStore()?.budget
  const declaredSize = contentLength(response)
  if (budget && declaredSize !== undefined) {
    try {
      budget.ensureResponseBodySize(declaredSize)
    } catch (error) {
      abandonBody(response)
      throw error
    }
  }

  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await readChunk(reader, getRequestSignal())
      if (done) break
      if (!value) continue

      length += value.byteLength
      if (budget) {
        try {
          budget.ensureResponseBodySize(length)
          budget.consumeUpstreamBody(value.byteLength)
        } catch (error) {
          abandonReader(reader)
          throw error
        }
      }
      chunks.push(value)
    }
  } catch (error) {
    abandonReader(reader)
    throw error
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function readResponseText(response: Response): Promise<string> {
  return new TextDecoder().decode(await readResponseBytes(response))
}

/**
 * Read only the head of a body — used to peek at whether the envelope looks
 * normal. It is deliberately not charged to the budget: the real read charges
 * the same bytes again, so counting here would double-bill.
 *
 * `complete` reports whether the body ended before `maxBytes` was reached —
 * i.e. whether what was read is the whole body. A caller must consult it
 * before concluding "empty body" from a prefix alone.
 */
export async function readBodyPrefix(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; complete: boolean }> {
  throwIfRequestCancelled()
  if (!response.body) return { text: "", complete: true }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let complete = false
  try {
    while (length < maxBytes) {
      const { done, value } = await readChunk(reader, getRequestSignal())
      if (done) { complete = true; break }
      if (!value) continue
      chunks.push(value)
      length += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), complete }
}

export async function readResponseArrayBuffer(response: Response): Promise<ArrayBuffer> {
  const bytes = await readResponseBytes(response)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
