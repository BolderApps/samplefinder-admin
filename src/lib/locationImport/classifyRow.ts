import { diffAddress } from './normalizeAddress'
import type {
  AddressFields, ClassifiedRow, GeocodeMatch, GeocodeOutcome, ParsedRow,
} from './types'

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

/**
 * Whether "Use Google" has anything to offer this row.
 *
 * The action means "Google's answer is the truth for this address", so it needs an
 * answer to adopt. A street Google cannot match does not come back as a failure —
 * it comes back as a postal_code-level hit: `partial_match`, `APPROXIMATE`, and no
 * `street_number` or `route` component at all, which leaves `match.address` empty.
 * Adopting that would change every field EXCEPT the street under suspicion, so the
 * row would be promoted to 'ready' with an unverified street and a ZIP-centroid for
 * coordinates — the operator clicking the primary button to certify exactly the
 * thing the review step flagged (SAM-16).
 *
 * Withholding it leaves the two honest routes intact: Edit to supply a real street
 * and re-check it against Google, or Keep mine to take explicit ownership of the
 * typed one.
 */
export function canUseGoogle(row: ClassifiedRow): row is ClassifiedRow & { match: GeocodeMatch } {
  return row.status === 'review' && row.match !== null && row.match.address.trim() !== ''
}

/**
 * Fold Google's answer into a reviewed row.
 *
 * Google can return an empty `locality` or `postal_code` (unincorporated areas are
 * the common case), so those fields fall back to what the operator typed rather than
 * being blanked out. The street is the one field with no fallback: `canUseGoogle`
 * refuses the whole action when Google has none, and the row keeps its review status,
 * its reason and its diff.
 */
export function applyGoogleMatch(row: ClassifiedRow): ClassifiedRow {
  if (!canUseGoogle(row)) return row
  const { match } = row
  return {
    ...row,
    address: match.address,
    city: match.city !== '' ? match.city : row.city,
    state: match.state !== '' ? match.state : row.state,
    zipCode: match.zipCode !== '' ? match.zipCode : row.zipCode,
    status: 'ready',
    reason: null,
    diff: [],
  }
}
