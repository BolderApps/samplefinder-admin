import { classifyRow } from './classifyRow'
import { findDuplicates } from './findDuplicates'
import type {
  ClassifiedRow, ExistingLocation, GeocodeOutcome, ParsedRow,
} from './types'

const DEFAULT_CONCURRENCY = 8

export interface ClassifyAllOptions {
  geocode: (row: ParsedRow) => Promise<GeocodeOutcome>
  concurrency?: number
}

export interface ClassifyAllResult {
  rows: ClassifiedRow[]
  /** Non-null when the batch stopped early; `rows` is then empty. */
  aborted: string | null
}

/**
 * The whole read-side pipeline: mark duplicates and parse errors without
 * touching the network, geocode only what is left, then classify.
 *
 * Duplicates are resolved BEFORE geocoding because re-uploading a corrected
 * sheet is the common case, and every already-imported row would otherwise be
 * paid for again.
 */
export async function classifyAll(
  rows: ParsedRow[],
  existing: ExistingLocation[],
  options: ClassifyAllOptions
): Promise<ClassifyAllResult> {
  const duplicates = findDuplicates(rows, existing)
  const results = new Array<ClassifiedRow>(rows.length)
  const queue: number[] = []

  rows.forEach((row, index) => {
    if (duplicates.has(row.rowNumber)) {
      const existingAddress = duplicates.get(row.rowNumber) ?? null
      results[index] = {
        ...row,
        status: 'duplicate',
        reason: existingAddress === null
          ? 'This name appears earlier in the file'
          : 'A location with this name already exists',
        match: null,
        diff: [],
        existing: existingAddress,
      }
    } else if (row.parseError !== null) {
      results[index] = classifyRow(row, { kind: 'none' })
    } else {
      queue.push(index)
    }
  })

  // Held in an object rather than a bare `let`: TypeScript does not narrow a
  // variable reassigned inside a closure, and reading it back after Promise.all
  // would otherwise be typed as `null`.
  const state: { aborted: string | null } = { aborted: null }
  let next = 0
  const workers = Array.from(
    { length: Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, queue.length) },
    async () => {
      while (state.aborted === null) {
        const cursor = next++
        if (cursor >= queue.length) return
        const index = queue[cursor]
        const outcome = await options.geocode(rows[index])
        if (outcome.kind === 'abort') {
          state.aborted = outcome.reason
          return
        }
        results[index] = classifyRow(rows[index], outcome)
      }
    }
  )
  await Promise.all(workers)

  if (state.aborted !== null) {
    return { rows: [], aborted: state.aborted }
  }
  return { rows: results, aborted: null }
}
