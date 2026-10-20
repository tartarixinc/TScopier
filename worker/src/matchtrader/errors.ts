export type Json = Record<string, unknown>

export function asRecordOf(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

export class MatchtraderApiError extends Error {
  status: number
  code: string | undefined
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'MatchtraderApiError'
    this.status = status
    this.code = code
  }
  /** True when the server may have processed the request (no answer, or a 5xx). */
  get uncertain(): boolean {
    return this.status === 0 || this.status >= 500
  }
}
