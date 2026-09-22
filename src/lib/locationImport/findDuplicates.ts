import type { AddressFields, ExistingLocation, ParsedRow } from './types'

const key = (name: string): string => name.trim().toLowerCase()

/**
 * Name collisions, against the table and within the file itself.
 *
 * The in-file case matters as much as the table case: two rows naming the same
 * store would create two records sharing a name, and the event importer's exact
 * name lookup would then bind events to whichever one it happened to read first.
 *
 * Returns rowNumber → the colliding record's address, or null when the collision
 * is with an earlier row in this same file.
 */
export function findDuplicates(
  rows: ParsedRow[],
  existing: ExistingLocation[]
): Map<number, AddressFields | null> {
  const byName = new Map<string, AddressFields>()
  existing.forEach((location) => {
    byName.set(key(location.name), {
      address: location.address,
      city: location.city,
      state: location.state,
      zipCode: location.zipCode,
    })
  })

  const duplicates = new Map<number, AddressFields | null>()
  const seenInFile = new Set<string>()

  rows.forEach((row) => {
    const name = key(row.name)
    if (name === '') return
    const inTable = byName.get(name)
    if (inTable !== undefined) {
      duplicates.set(row.rowNumber, inTable)
    } else if (seenInFile.has(name)) {
      duplicates.set(row.rowNumber, null)
    }
    seenInFile.add(name)
  })

  return duplicates
}
