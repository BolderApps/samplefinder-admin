import ImportRowCard from './ImportRowCard'
import type { AddressFields, ClassifiedRow, RowStatus } from '../../../lib/locationImport'

interface ImportReviewTableProps {
  rows: ClassifiedRow[]
  skipped: Set<number>
  onUseGoogle: (rowNumber: number) => void
  onKeepMine: (rowNumber: number) => void
  onEdit: (rowNumber: number, fields: AddressFields) => void
  onSkip: (rowNumber: number) => void
}

// Problems first. 'ready' is precisely what the operator does not need to look at,
// so it goes last and starts collapsed.
const GROUP_ORDER: RowStatus[] = ['review', 'failed', 'duplicate', 'ready']

const GROUP_TITLES: Record<RowStatus, string> = {
  review: 'Need review',
  failed: 'Failed',
  duplicate: 'Already exist',
  ready: 'Ready to import',
}

const SUMMARY_ICONS: Record<RowStatus, string> = {
  ready: '✅',
  review: '⚠️',
  failed: '❌',
  duplicate: 'ℹ️',
}

const ImportReviewTable = ({ rows, skipped, ...handlers }: ImportReviewTableProps) => {
  const byStatus = (status: RowStatus) => rows.filter((row) => row.status === status)

  return (
    <div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm font-medium text-gray-800 mb-5">
        {(['ready', 'review', 'failed', 'duplicate'] as RowStatus[]).map((status) => (
          <span key={status}>
            {SUMMARY_ICONS[status]} {byStatus(status).length} {GROUP_TITLES[status].toLowerCase()}
          </span>
        ))}
      </div>

      {GROUP_ORDER.map((status) => {
        const group = byStatus(status)
        if (group.length === 0) return null

        const cards = (
          <div className="space-y-3">
            {group.map((row) => (
              <ImportRowCard
                key={row.rowNumber}
                row={row}
                skipped={skipped.has(row.rowNumber)}
                {...handlers}
              />
            ))}
          </div>
        )

        if (status === 'ready') {
          return (
            <details key={status} className="mb-6">
              <summary className="cursor-pointer text-sm font-semibold text-gray-900 mb-3">
                {GROUP_TITLES[status]} ({group.length})
              </summary>
              {cards}
            </details>
          )
        }

        return (
          <section key={status} className="mb-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">
              {GROUP_TITLES[status]} ({group.length})
            </h3>
            {cards}
          </section>
        )
      })}
    </div>
  )
}

export default ImportReviewTable
