import type { ImportField, ParsedRow, ParseResult } from './types'

const MAX_ROWS = 1000

const REQUIRED_FIELDS: ImportField[] = ['name', 'address', 'city', 'state', 'zipCode']

const FIELD_LABELS: Record<ImportField, string> = {
  name: 'Name',
  address: 'Address',
  city: 'City',
  state: 'State',
  zipCode: 'Zip',
}

const HEADER_ALIASES: Record<string, ImportField> = {
  'name': 'name',
  'location name': 'name',
  'address': 'address',
  'street': 'address',
  'street address': 'address',
  'city': 'city',
  'state': 'state',
  'zip': 'zipCode',
  'zip code': 'zipCode',
  'zipcode': 'zipCode',
  'postal code': 'zipCode',
}

/**
 * Split one CSV line, honouring quoted fields and doubled-quote escapes.
 * The event importer's parser toggles on every quote and so mishandles `""`;
 * this one is written correctly rather than copied.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      out.push(current)
      current = ''
    } else {
      current += char
    }
  }
  out.push(current)
  return out.map((value) => value.trim())
}

export function parseLocationsCsv(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 2) {
    return { rows: [], fileError: 'CSV must have a header row and at least one data row' }
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim())
  const columnField = new Map<number, ImportField>()
  headers.forEach((header, index) => {
    const field = HEADER_ALIASES[header]
    if (field !== undefined && !Array.from(columnField.values()).includes(field)) {
      columnField.set(index, field)
    }
  })

  const present = new Set(columnField.values())
  const missing = REQUIRED_FIELDS.filter((field) => !present.has(field))
  if (missing.length > 0) {
    return {
      rows: [],
      fileError: `Missing required column(s): ${missing.map((f) => FIELD_LABELS[f]).join(', ')}`,
    }
  }

  const dataLines = lines.slice(1)
  if (dataLines.length > MAX_ROWS) {
    return {
      rows: [],
      fileError: `CSV has ${dataLines.length} rows; the limit is ${MAX_ROWS} per import`,
    }
  }

  const rows: ParsedRow[] = dataLines.map((line, index) => {
    const values = splitCsvLine(line)
    const row: ParsedRow = {
      rowNumber: index + 1,
      name: '',
      address: '',
      city: '',
      state: '',
      zipCode: '',
      parseError: null,
    }
    columnField.forEach((field, columnIndex) => {
      row[field] = values[columnIndex] ?? ''
    })
    const blank = REQUIRED_FIELDS.find((field) => row[field].trim() === '')
    if (blank !== undefined) {
      row.parseError = `Missing required field: ${FIELD_LABELS[blank]}`
    }
    return row
  })

  return { rows, fileError: null }
}
