import { useState } from 'react'
import { Icon } from '@iconify/react'
import type { AddressFields, ClassifiedRow } from '../../../lib/locationImport'

interface ImportRowCardProps {
  row: ClassifiedRow
  skipped: boolean
  onUseGoogle: (rowNumber: number) => void
  onKeepMine: (rowNumber: number) => void
  onEdit: (rowNumber: number, fields: AddressFields) => void
  onSkip: (rowNumber: number) => void
}

const STATUS_STYLES: Record<ClassifiedRow['status'], { pill: string; label: string; icon: string }> = {
  ready: { pill: 'bg-green-100 text-green-800', label: 'Ready', icon: 'mdi:check-circle' },
  review: { pill: 'bg-amber-100 text-amber-800', label: 'Needs review', icon: 'mdi:alert' },
  failed: { pill: 'bg-red-100 text-red-800', label: 'Failed', icon: 'mdi:close-circle' },
  duplicate: { pill: 'bg-gray-100 text-gray-700', label: 'Already exists', icon: 'mdi:information' },
}

const FIELD_LABELS: Record<keyof AddressFields, string> = {
  address: 'Address',
  city: 'City',
  state: 'State',
  zipCode: 'Zip',
}

const ADDRESS_FIELDS = Object.keys(FIELD_LABELS) as (keyof AddressFields)[]

const BTN_PRIMARY = 'px-3 py-1.5 bg-[#1D0A74] text-white rounded-lg text-sm font-medium hover:bg-[#15065c] transition-colors'
const BTN_SECONDARY = 'px-3 py-1.5 bg-[#1D0A74]/10 text-[#1D0A74] rounded-lg text-sm font-medium hover:bg-[#1D0A74]/20 transition-colors'
const BTN_MUTED = 'px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300 transition-colors'

const ImportRowCard = ({
  row, skipped, onUseGoogle, onKeepMine, onEdit, onSkip,
}: ImportRowCardProps) => {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<AddressFields>({
    address: row.address, city: row.city, state: row.state, zipCode: row.zipCode,
  })

  const style = STATUS_STYLES[row.status]
  // A blank name is the one rejection the form cannot repair — it edits the address
  // fields only, and the name is deliberately not editable. Offering Edit there would
  // invite the operator to "fix" a row that can never become importable.
  const canEdit = (row.status === 'review' || row.status === 'failed') && row.name.trim() !== ''

  const resetDraft = () => setDraft({
    address: row.address, city: row.city, state: row.state, zipCode: row.zipCode,
  })

  return (
    <div className={`border rounded-lg p-4 ${skipped ? 'opacity-50 border-gray-200' : 'border-gray-300'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The name is deliberately not editable — the client's naming convention is authoritative. */}
          <p className="font-semibold text-gray-900 truncate">
            <span className="text-gray-400 font-normal mr-2">#{row.rowNumber}</span>
            {row.name}
          </p>
          <p className="text-sm text-gray-600">
            {row.address}, {row.city}, {row.state} {row.zipCode}
          </p>
        </div>
        <span className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium flex items-center gap-1 ${style.pill}`}>
          <Icon icon={style.icon} className="w-4 h-4" />
          {skipped ? 'Skipped' : style.label}
        </span>
      </div>

      {row.reason !== null && <p className="mt-2 text-sm text-gray-700">{row.reason}</p>}

      {row.diff.length > 0 && (
        <dl className="mt-3 space-y-1 text-sm">
          {row.diff.map((difference) => (
            <div key={difference.field} className="grid grid-cols-[5rem_1fr] gap-2">
              <dt className="text-gray-500">{FIELD_LABELS[difference.field]}</dt>
              <dd>
                <span className="line-through text-gray-500">{difference.typed || '(blank)'}</span>
                <span className="mx-1.5 text-gray-400">&rarr;</span>
                <span className="font-medium text-gray-900">{difference.google}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {row.existing !== null && (
        <p className="mt-2 text-sm text-gray-500">
          Existing record: {row.existing.address}, {row.existing.city}, {row.existing.state}{' '}
          {row.existing.zipCode}
        </p>
      )}

      {isEditing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setIsEditing(false)
            onEdit(row.rowNumber, draft)
          }}
          className="mt-3 grid grid-cols-2 gap-3"
        >
          {ADDRESS_FIELDS.map((field) => (
            <label key={field} className="text-sm">
              <span className="block text-gray-700 mb-1">{FIELD_LABELS[field]}</span>
              <input
                value={draft[field]}
                onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1D0A74]/30"
              />
            </label>
          ))}
          <div className="col-span-2 flex gap-2">
            <button type="submit" className={BTN_PRIMARY}>
              Save &amp; re-check
            </button>
            <button
              type="button"
              onClick={() => { setIsEditing(false); resetDraft() }}
              className={BTN_MUTED}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        row.status !== 'duplicate' && (
          <div className="mt-3 flex flex-wrap gap-2">
            {/* 'Keep mine' is offered only on review rows, which always carry a match
                and therefore have coordinates to adopt. */}
            {row.status === 'review' && (
              <>
                <button onClick={() => onUseGoogle(row.rowNumber)} className={BTN_PRIMARY}>
                  Use Google
                </button>
                <button onClick={() => onKeepMine(row.rowNumber)} className={BTN_SECONDARY}>
                  Keep mine
                </button>
              </>
            )}
            {canEdit && (
              <button onClick={() => { resetDraft(); setIsEditing(true) }} className={BTN_SECONDARY}>
                Edit
              </button>
            )}
            <button onClick={() => onSkip(row.rowNumber)} className={BTN_MUTED}>
              {skipped ? 'Include' : 'Skip'}
            </button>
          </div>
        )
      )}
    </div>
  )
}

export default ImportRowCard
