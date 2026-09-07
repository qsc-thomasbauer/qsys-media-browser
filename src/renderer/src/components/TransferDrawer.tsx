/**
 * Transfer drawer.
 *
 * Progress comes from a push channel rather than polling, so the bar tracks
 * actual bytes written. A transfer with no `content-length` shows an
 * indeterminate sweep instead of a fake percentage.
 */
import { FolderOpen, X, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import type { TransferItem } from '@shared/types'
import { api } from '@/lib/api'
import { formatBytes, formatRate } from '@/lib/format'
import { useUi } from '@/store'
import { Button, IconButton, ProgressBar } from './primitives'

const STATE_LABEL: Record<TransferItem['state'], string> = {
  queued: 'Waiting',
  active: '',
  done: 'Complete',
  error: 'Failed',
  cancelled: 'Cancelled'
}

export function TransferDrawer({ transfers }: { transfers: TransferItem[] }): ReactNode {
  const open = useUi((s) => s.showTransfers)
  const setOpen = useUi((s) => s.setShowTransfers)

  const activeCount = transfers.filter(
    (item) => item.state === 'active' || item.state === 'queued'
  ).length
  const finishedCount = transfers.length - activeCount

  if (!open) {
    // Collapsed: a single strip that only appears when there is something to say.
    if (activeCount === 0) return null
    return (
      <button
        type="button"
        className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-surface-1 px-3 text-left text-[12px] text-ink-muted hover:bg-surface-2"
        onClick={() => setOpen(true)}
      >
        <span className="font-medium text-ink">
          {activeCount} transfer{activeCount === 1 ? '' : 's'} in progress
        </span>
        <ProgressBar value={overallProgress(transfers)} className="max-w-48 flex-1" />
        <span className="ml-auto text-ink-faint">Show details</span>
      </button>
    )
  }

  return (
    <section
      aria-label="Transfers"
      className="flex h-56 shrink-0 flex-col border-t border-line bg-surface-1"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="text-[12.5px] font-semibold text-ink">Transfers</h2>
        <span className="text-[11.5px] text-ink-faint">
          {activeCount > 0 ? `${activeCount} in progress` : 'Idle'}
        </span>
        <div className="flex-1" />
        {finishedCount > 0 ? (
          <Button variant="ghost" onClick={() => void api.clearFinishedTransfers()}>
            Clear finished
          </Button>
        ) : null}
        <IconButton
          icon={<X size={14} />}
          title="Hide transfers"
          aria-label="Hide transfers"
          onClick={() => setOpen(false)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {transfers.length === 0 ? (
          <p className="px-3 py-4 text-[12px] text-ink-faint">
            Uploads and downloads will appear here.
          </p>
        ) : (
          <ul>
            {transfers.map((item) => (
              <TransferRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function TransferRow({ item }: { item: TransferItem }): ReactNode {
  const inFlight = item.state === 'active' || item.state === 'queued'
  const fraction = item.total && item.total > 0 ? item.bytes / item.total : null

  return (
    <li className="flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-b-0">
      <span
        className={clsx(
          'w-14 shrink-0 text-[10.5px] font-semibold uppercase tracking-wide',
          item.kind === 'upload' ? 'text-brand' : 'text-accent'
        )}
      >
        {item.kind}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[12.5px] text-ink">{item.name}</span>
          <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-ink-muted">
            {item.state === 'active'
              ? `${formatBytes(item.bytes)}${item.total ? ` / ${formatBytes(item.total)}` : ''}`
              : STATE_LABEL[item.state]}
          </span>
        </div>

        {inFlight ? (
          <ProgressBar
            value={item.state === 'queued' ? 0 : fraction}
            className="mt-1.5"
          />
        ) : null}

        {item.state === 'error' && item.error ? (
          <p className="mt-1 select-text text-[11.5px] text-danger">{item.error}</p>
        ) : null}

        {item.state === 'active' ? (
          <p className="mt-1 text-[11px] text-ink-faint">{formatRate(item.bytes, item.startedAt)}</p>
        ) : null}
      </div>

      {inFlight ? (
        <IconButton
          icon={<XCircle size={14} />}
          title="Cancel"
          aria-label={`Cancel ${item.name}`}
          onClick={() => void api.cancelTransfer(item.id)}
        />
      ) : item.state === 'done' && item.kind === 'download' ? (
        <IconButton
          icon={<FolderOpen size={14} />}
          title="Show in folder"
          aria-label={`Show ${item.name} in folder`}
          onClick={() => void api.revealInFolder(item.localPath)}
        />
      ) : (
        <span className="w-7 shrink-0" />
      )}
    </li>
  )
}

/** Aggregate progress across everything still running. */
function overallProgress(transfers: TransferItem[]): number | null {
  const running = transfers.filter((item) => item.state === 'active' || item.state === 'queued')
  if (running.length === 0) return null
  // Only count items whose size is known; a single unknown-size transfer should
  // not drag the whole bar to indeterminate.
  const sized = running.filter((item) => item.total && item.total > 0)
  if (sized.length === 0) return null
  const done = sized.reduce((sum, item) => sum + item.bytes, 0)
  const total = sized.reduce((sum, item) => sum + (item.total ?? 0), 0)
  return total === 0 ? null : done / total
}
