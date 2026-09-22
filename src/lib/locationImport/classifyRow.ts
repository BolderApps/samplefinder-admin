import { diffAddress } from './normalizeAddress'
import type { AddressFields, ClassifiedRow, GeocodeOutcome, ParsedRow } from './types'

/** Google precision levels we accept without asking the operator. */
const PRECISE_LOCATION_TYPES = ['ROOFTOP', 'RANGE_INTERPOLATED']

export function classifyRow(row: ParsedRow, outcome: GeocodeOutcome): ClassifiedRow {
  const base: ClassifiedRow = {
    ...row,
    status: 'failed',
    reason: null,
    match: null,
    diff: [],
    existing: null,
  }

  if (row.parseError !== null) {
    return { ...base, status: 'failed', reason: row.parseError }
  }

  if (outcome.kind !== 'match') {
    // 'abort' never reaches here — classifyAll stops the batch first.
    return { ...base, status: 'failed', reason: 'Google Maps found no match for this address' }
  }

  const { match } = outcome
  const diff = diffAddress(row, match)

  if (match.partialMatch) {
    return { ...base, status: 'review', reason: 'Google returned only a partial match', match, diff }
  }
  if (!PRECISE_LOCATION_TYPES.includes(match.locationType)) {
    return {
      ...base,
      status: 'review',
      reason: 'Google could only match this address approximately',
      match,
      diff,
    }
  }
  if (diff.length > 0) {
    return {
      ...base,
      status: 'review',
      reason: "Google's address differs from what you entered",
      match,
      diff,
    }
  }
  return { ...base, status: 'ready', reason: null, match, diff: [] }
}

/**
 * Fold the operator's inline edits into a row, ready to be re-classified.
 *
 * The edit form covers address, city, state and zip — it deliberately cannot set the
 * name, because the client's naming convention is authoritative. So a row rejected
 * for a blank name keeps that rejection however the address is edited: clearing it
 * would let the row classify 'ready' and write a nameless record, which is precisely
 * the junk this feature exists to keep out of the table (and which the event
 * importer's exact-name lookup could never resolve).
 */
export function applyAddressEdit(row: ParsedRow, fields: AddressFields): ParsedRow {
  return {
    ...row,
    ...fields,
    parseError: row.name.trim() === '' ? 'Missing required field: Name' : null,
  }
}
