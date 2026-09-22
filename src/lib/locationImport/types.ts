/** The five columns an import CSV carries. */
export type ImportField = 'name' | 'address' | 'city' | 'state' | 'zipCode'

export interface AddressFields {
  address: string
  city: string
  state: string
  zipCode: string
}

/** One data row as read from the file, before any network call. */
export interface ParsedRow extends AddressFields {
  /** 1-based index among data rows, excluding the header. Shown to the operator. */
  rowNumber: number
  name: string
  /** Non-null when a required field was blank; such a row is never geocoded. */
  parseError: string | null
}

export interface ParseResult {
  rows: ParsedRow[]
  /** Non-null means the whole file was rejected and `rows` is empty. */
  fileError: string | null
}

/** An existing location, used only for duplicate detection. */
export interface ExistingLocation extends AddressFields {
  name: string
}

/** Google's answer, flattened to the fields we care about. */
export interface GeocodeMatch extends AddressFields {
  /** administrative_area_level_1 long_name, e.g. "Pennsylvania" — this is what we store. */
  state: string
  /** administrative_area_level_1 short_name, e.g. "PA" — accepted on input, never stored. */
  stateShort: string
  longitude: number
  latitude: number
  partialMatch: boolean
  /** ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE */
  locationType: string
}

export type GeocodeOutcome =
  | { kind: 'match'; match: GeocodeMatch }
  /** ZERO_RESULTS or INVALID_REQUEST — this row failed, the batch continues. */
  | { kind: 'none' }
  /**
   * UNKNOWN_ERROR — Google's "try again" status. Resolved inside
   * createGoogleGeocoder by retrying; it never escapes to classifyRow.
   */
  | { kind: 'retry' }
  /** OVER_QUERY_LIMIT or REQUEST_DENIED — the whole batch stops. */
  | { kind: 'abort'; reason: string }

export interface FieldDiff {
  field: keyof AddressFields
  typed: string
  google: string
}

export type RowStatus = 'ready' | 'review' | 'failed' | 'duplicate'

export interface ClassifiedRow extends ParsedRow {
  status: RowStatus
  /** Operator-facing explanation; null when status is 'ready'. */
  reason: string | null
  match: GeocodeMatch | null
  diff: FieldDiff[]
  /**
   * For duplicates: the colliding record's address, or null when the collision
   * is with an earlier row in the same file.
   */
  existing: AddressFields | null
}

/**
 * Minimal fetch shape. Declared locally rather than using the DOM/node `fetch`
 * type so the standalone `tsc` used by the verify script needs no extra libs.
 */
export type FetchLike = (url: string) => Promise<{ json: () => Promise<unknown> }>
