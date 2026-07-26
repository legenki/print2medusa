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
}

export class PrintfulConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PrintfulConfigError"
  }
}
