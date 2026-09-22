import type { AddressFields, FetchLike, GeocodeMatch, GeocodeOutcome, ParsedRow } from './types'

const ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json'

/** Statuses that mean the key or quota is broken, so continuing would waste the batch. */
const ABORT_REASONS: Record<string, string> = {
  OVER_QUERY_LIMIT: 'Google Maps quota exceeded. Try again later.',
  REQUEST_DENIED: 'Google Maps rejected the request. Check the API key.',
}

/** Backoff before each retry of an UNKNOWN_ERROR, in milliseconds. */
const RETRY_DELAYS_MS = [250, 1000]

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function buildGeocodeQuery(row: AddressFields): string {
  return `${row.address}, ${row.city}, ${row.state} ${row.zipCode}`.trim()
}

interface RawComponent { types?: string[]; long_name?: string; short_name?: string }

function component(components: RawComponent[], type: string): RawComponent | undefined {
  return components.find((c) => Array.isArray(c.types) && c.types.includes(type))
}

export function mapGeocodeResponse(json: unknown): GeocodeOutcome {
  const body = json as { status?: string; results?: unknown[] } | null
  const status = body?.status
  if (typeof status === 'string') {
    const abortReason = ABORT_REASONS[status]
    if (abortReason !== undefined) {
      return { kind: 'abort', reason: abortReason }
    }
    if (status === 'UNKNOWN_ERROR') {
      return { kind: 'retry' }
    }
  }
  const first = Array.isArray(body?.results) ? body.results[0] : undefined
  if (status !== 'OK' || first === undefined) {
    return { kind: 'none' }
  }

  const result = first as {
    partial_match?: boolean
    address_components?: RawComponent[]
    geometry?: { location_type?: string; location?: { lat?: number; lng?: number } }
  }
  const components = Array.isArray(result.address_components) ? result.address_components : []
  const lat = result.geometry?.location?.lat
  const lng = result.geometry?.location?.lng
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return { kind: 'none' }
  }

  const streetNumber = component(components, 'street_number')?.long_name ?? ''
  // short_name gives the abbreviated route ("S Broad St"), which is what the
  // comparison normalizer and the stored record both expect.
  const route = component(components, 'route')?.short_name ?? ''
  const state = component(components, 'administrative_area_level_1')

  const match: GeocodeMatch = {
    address: `${streetNumber} ${route}`.trim(),
    city: component(components, 'locality')?.long_name ?? '',
    state: state?.long_name ?? '',
    stateShort: state?.short_name ?? '',
    zipCode: component(components, 'postal_code')?.long_name ?? '',
    longitude: lng,
    latitude: lat,
    partialMatch: result.partial_match === true,
    locationType: result.geometry?.location_type ?? '',
  }
  return { kind: 'match', match }
}

/**
 * The live geocoder. `fetchImpl` is injected so the verification script can
 * exercise everything above without network access.
 *
 * UNKNOWN_ERROR is Google's explicit "this was transient, try again" status, so
 * it is retried here rather than being reported to the operator as a bad
 * address. After the retries are spent it degrades to an ordinary row failure,
 * which the operator can resolve with Edit. A network-level throw is treated the
 * same way: one bad row must never take down a 400-row batch.
 */
export function createGoogleGeocoder(
  apiKey: string,
  fetchImpl: FetchLike
): (row: ParsedRow) => Promise<GeocodeOutcome> {
  return async (row) => {
    const url = `${ENDPOINT}?address=${encodeURIComponent(buildGeocodeQuery(row))}`
      + `&components=country:US&key=${apiKey}`

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      let outcome: GeocodeOutcome
      try {
        const response = await fetchImpl(url)
        outcome = mapGeocodeResponse(await response.json())
      } catch {
        outcome = { kind: 'retry' }
      }
      if (outcome.kind !== 'retry') {
        return outcome
      }
      if (attempt < RETRY_DELAYS_MS.length) {
        await wait(RETRY_DELAYS_MS[attempt])
      }
    }
    return { kind: 'none' }
  }
}
