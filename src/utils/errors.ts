export class PrintfulApiError extends Error {
  readonly status: number
  readonly reason?: string
  readonly body?: unknown

  constructor(
    message: string,
    options: { status: number; reason?: string; body?: unknown }
  ) {
    super(message)
    this.name = "PrintfulApiError"
    this.status = options.status
    this.reason = options.reason
    this.body = options.body
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500
  }

  /**
   * True when this error proves the request was *rejected* — Printful read it,
   * refused it, and created nothing.
   *
   * Only these make it safe to release a create claim without asking Printful
   * what happened. Everything else — timeouts, dropped sockets, 5xx, 429 — has
   * an unknown outcome: the order may exist.
   *
   * 409 is excluded deliberately. On create it can mean "an order with this
   * external_id already exists", which is exactly the case where releasing the
   * claim and retrying prints a second order. Treating it as unknown sends the
   * caller to look the order up instead of guessing.
   */
  get provesNotCreated(): boolean {
    return (
      this.status >= 400 &&
      this.status < 500 &&
      this.status !== 429 &&
      this.status !== 409
    )
  }
}

export class PrintfulConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PrintfulConfigError"
  }
}
