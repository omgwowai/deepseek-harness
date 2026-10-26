/**
 * Defensive JSON readers shared by the Codex native transport modules.
 *
 * Everything the app-server sends is untrusted structure from the transport's
 * point of view: the protocol evolves between Codex releases, so every read is
 * checked instead of cast.
 */

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

export function readString(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

export function readNumber(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readBoolean(record: JsonRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key]
  return typeof value === 'boolean' ? value : undefined
}

export function readArray(record: JsonRecord | undefined, key: string): unknown[] | undefined {
  const value = record?.[key]
  return Array.isArray(value) ? value : undefined
}

export function readStringArray(record: JsonRecord | undefined, key: string): string[] {
  const value = readArray(record, key)
  return value === undefined ? [] : value.filter((entry): entry is string => typeof entry === 'string')
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}
