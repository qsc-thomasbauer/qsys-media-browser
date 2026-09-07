/**
 * Preview player.
 *
 * `src` is a `qsys-media://` URL, which the main process resolves against the
 * Core with the bearer token attached - so playback works without the renderer
 * ever holding a credential, and Chromium's own range requests drive seeking.
 *
 * Not every format the Core will store is one Chromium can decode (AIFF, in
 * particular). Rather than pre-filtering, the element's error is surfaced with
 * a suggestion to download instead.
 */
import { Pause, Play, Volume2, VolumeX, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import { useUi } from '@/store'
import { IconButton } from './primitives'

export function AudioPlayer(): ReactNode {
  const nowPlaying = useUi((s) => s.nowPlaying)
  const play = useUi((s) => s.play)

  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [failed, setFailed] = useState(false)

  // A new track resets everything and starts playing; autoplay is safe here
  // because it is always a direct response to the user opening a file.
  useEffect(() => {
    setPlaying(false)
    setPosition(0)
    setDuration(0)
    setFailed(false)
    if (!nowPlaying) return

    const element = audio.current
    if (!element) return
    element.load()
    void element.play().catch(() => setFailed(true))
  }, [nowPlaying?.path])

  if (!nowPlaying) return null

  const toggle = (): void => {
    const element = audio.current
    if (!element) return
    if (element.paused) void element.play().catch(() => setFailed(true))
    else element.pause()
  }

  const progress = duration > 0 ? position / duration : 0

  return (
    <section
      aria-label="Preview player"
      className="flex h-12 shrink-0 items-center gap-3 border-t border-line bg-surface-2 px-3"
    >
      <audio
        ref={audio}
        src={api.mediaUrl(nowPlaying.path)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onError={() => setFailed(true)}
      />

      <IconButton
        variant="primary"
        icon={playing ? <Pause size={14} /> : <Play size={14} />}
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={failed}
        onClick={toggle}
      />

      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] text-ink">{nowPlaying.name}</p>
        {failed ? (
          <p className="text-[11.5px] text-danger">
            This file cannot be played here. Download it to listen.
          </p>
        ) : (
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={progress}
            aria-label="Seek"
            className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--primary)]"
            style={{
              background: `linear-gradient(to right, var(--primary) ${progress * 100}%, var(--surface-3) ${progress * 100}%)`
            }}
            onChange={(event) => {
              const element = audio.current
              if (!element || !Number.isFinite(duration) || duration === 0) return
              element.currentTime = Number(event.target.value) * duration
            }}
          />
        )}
      </div>

      <span className="shrink-0 text-[11.5px] tabular-nums text-ink-muted">
        {formatDuration(position)} / {Number.isFinite(duration) ? formatDuration(duration) : '—'}
      </span>

      <IconButton
        icon={muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        title={muted ? 'Unmute' : 'Mute'}
        aria-label={muted ? 'Unmute' : 'Mute'}
        onClick={() => {
          const element = audio.current
          if (!element) return
          element.muted = !element.muted
          setMuted(element.muted)
        }}
      />

      <IconButton
        icon={<X size={14} />}
        title="Close player"
        aria-label="Close player"
        onClick={() => play(null)}
      />
    </section>
  )
}
