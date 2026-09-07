/**
 * Application header: customer identity on the left, Core status on the right.
 *
 * The logo and product name come from the build-time config, so this is the
 * most visible place a customer build differs from another.
 */
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, ListMusic, RefreshCw, ShieldAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ConnectionStatus } from '@shared/types'
import { api, config } from '@/lib/api'
import { useUi } from '@/store'
import { Button, IconButton, Spinner } from './primitives'

const DOT: Record<ConnectionStatus['state'], string> = {
  idle: 'bg-ink-faint',
  connecting: 'bg-accent',
  connected: 'bg-accent',
  error: 'bg-danger'
}

const LABEL: Record<ConnectionStatus['state'], string> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  connected: 'Connected',
  error: 'Connection problem'
}

export function Header({ status }: { status: ConnectionStatus }): ReactNode {
  const showPlaylists = useUi((s) => s.showPlaylists)
  const setShowPlaylists = useUi((s) => s.setShowPlaylists)

  const reconnect = useMutation({ mutationFn: () => api.connect() })
  const connecting = status.state === 'connecting' || reconnect.isPending

  return (
    <header className="flex flex-col border-b border-line bg-surface-1">
      <div className="flex h-12 items-center gap-3 px-3">
        <img
          src={config.logoDataUri}
          alt={config.productName}
          className="drag-none h-7 max-w-[190px] object-contain object-left"
        />

        <div className="flex-1" />

        {config.features.playlists ? (
          <Button
            variant={showPlaylists ? 'primary' : 'ghost'}
            icon={<ListMusic size={14} />}
            onClick={() => setShowPlaylists(!showPlaylists)}
            aria-pressed={showPlaylists}
          >
            Playlists
          </Button>
        ) : null}

        <div className="flex items-center gap-2 rounded-md border border-line bg-surface-0 px-2.5 py-1.5">
          {connecting ? (
            <Spinner className="h-3 w-3 text-accent" />
          ) : (
            <span
              className={`h-2 w-2 rounded-full ${DOT[status.state]}`}
              aria-hidden="true"
            />
          )}
          <span className="text-[12px] text-ink-muted">
            {connecting ? 'Connecting' : LABEL[status.state]}
          </span>
          {status.state === 'error' ? (
            <IconButton
              icon={<RefreshCw size={13} />}
              title="Try again"
              aria-label="Try connecting again"
              disabled={connecting}
              onClick={() => reconnect.mutate()}
            />
          ) : null}
        </div>
      </div>

      {status.state === 'error' && status.message ? (
        <Banner tone="danger" icon={<AlertTriangle size={14} />}>
          {status.message}
        </Banner>
      ) : null}

      {status.certChanged ? (
        <Banner tone="warn" icon={<ShieldAlert size={14} />}>
          The Core is presenting a different security certificate than the one seen the first time
          this app connected. That is expected if the certificate was renewed - but if it was not,
          stop and check with whoever manages this Core.
        </Banner>
      ) : null}
    </header>
  )
}

function Banner({
  tone,
  icon,
  children
}: {
  tone: 'danger' | 'warn'
  icon: ReactNode
  children: ReactNode
}): ReactNode {
  const classes =
    tone === 'danger'
      ? 'bg-danger-subtle text-ink border-danger/40'
      : 'bg-accent-subtle text-ink border-accent/40'
  return (
    <div className={`flex items-start gap-2 border-t px-3 py-2 text-[12px] ${classes}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <p className="select-text">{children}</p>
    </div>
  )
}
