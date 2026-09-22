import type { AddressFields, FieldDiff, GeocodeMatch, ParsedRow } from './types'

/**
 * Long form → abbreviation. Street suffixes AND directional words are folded,
 * because both are spelling style rather than meaning. A directional is never
 * added or removed, so an omitted "S" still shows up as a difference — which is
 * precisely the error SAM-8 exists to catch.
 */
const TOKEN_ALIASES: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', BOULEVARD: 'BLVD', DRIVE: 'DR',
  LANE: 'LN', COURT: 'CT', PARKWAY: 'PKWY', HIGHWAY: 'HWY', SUITE: 'STE',
  PLACE: 'PL', TERRACE: 'TER', CIRCLE: 'CIR', TRAIL: 'TRL', SQUARE: 'SQ',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
}

export function normalizeForCompare(value: string): string {
  return value
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => TOKEN_ALIASES[token] ?? token)
    .join(' ')
}

export function statesMatch(
  typed: string,
  match: Pick<GeocodeMatch, 'state' | 'stateShort'>
): boolean {
  const normalized = normalizeForCompare(typed)
  return normalized === normalizeForCompare(match.state)
    || normalized === normalizeForCompare(match.stateShort)
}

/** Compare the 5-digit prefix, so a typed ZIP+4 matches Google's 5-digit answer. */
export function zipsMatch(typed: string, google: string): boolean {
  return typed.replace(/\D/g, '').slice(0, 5) === google.replace(/\D/g, '').slice(0, 5)
}

export function diffAddress(
  row: Pick<ParsedRow, keyof AddressFields>,
  match: Pick<GeocodeMatch, keyof AddressFields | 'stateShort'>
): FieldDiff[] {
  const diff: FieldDiff[] = []
  if (normalizeForCompare(row.address) !== normalizeForCompare(match.address)) {
    diff.push({ field: 'address', typed: row.address, google: match.address })
  }
  if (normalizeForCompare(row.city) !== normalizeForCompare(match.city)) {
    diff.push({ field: 'city', typed: row.city, google: match.city })
  }
  if (!statesMatch(row.state, match)) {
    diff.push({ field: 'state', typed: row.state, google: match.state })
  }
  if (!zipsMatch(row.zipCode, match.zipCode)) {
    diff.push({ field: 'zipCode', typed: row.zipCode, google: match.zipCode })
  }
  return diff
}

/**
 * The state spelling to persist.
 *
 * Google's long name is the canonical form: AddressAutocomplete and LocationPicker
 * both read `administrative_area_level_1.long_name`, so every record created by hand
 * holds "Pennsylvania". A CSV that typed "PA" is therefore widened to match.
 *
 * But widening is only correct when the two names denote the SAME state. When the
 * operator reviewed a state difference and pressed "Keep mine", their value is the
 * decision — overwriting it with Google's would silently discard the correction the
 * review step exists to collect.
 */
export function resolveStateForWrite(
  typed: string,
  match: Pick<GeocodeMatch, 'state' | 'stateShort'> | null
): string {
  if (match === null) return typed
  return statesMatch(typed, match) ? match.state : typed
}
