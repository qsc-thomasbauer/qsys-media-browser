/**
 * Shared UI primitives.
 *
 * Every colour here is a theme token, never a literal, so a customer's palette
 * propagates through the whole app by setting three hex values.
 */
import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { forwardRef, useEffect, useRef } from 'react'

/* ------------------------------------------------------------------ Button */

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  icon?: ReactNode
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand text-brand-ink hover:bg-brand-hover active:bg-brand-active border border-transparent',
  subtle: 'bg-surface-2 text-ink hover:bg-surface-3 border border-line',
  ghost: 'bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink border border-transparent',
  danger: 'bg-danger text-danger-ink hover:bg-danger-hover border border-transparent'
}

export function Button({
  variant = 'subtle',
  icon,
  className,
  children,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium',
        'transition-colors duration-75 disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}

/** Square icon-only button, for toolbars where the icon is self-explanatory. */
export function IconButton({
  variant = 'ghost',
  icon,
  className,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex h-7 w-7 items-center justify-center rounded-md',
        'transition-colors duration-75 disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {icon}
    </button>
  )
}

/* ------------------------------------------------------------------- Input */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={clsx(
          'w-full rounded-md border border-line bg-surface-0 px-2.5 py-1.5 text-[13px] text-ink',
          'placeholder:text-ink-faint focus:border-brand focus:outline-none',
          className
        )}
        {...rest}
      />
    )
  }
)

/* ------------------------------------------------------------------ Dialog */

interface DialogProps {
  title: string
  children: ReactNode
  footer: ReactNode
  onClose(): void
}

/**
 * A modal. Focus is trapped loosely (first field autofocused, Escape closes);
 * the app has no nested modals, so a full focus-trap implementation would be
 * more machinery than the problem needs.
 */
export function Dialog({ title, children, footer, onClose }: DialogProps): ReactNode {
  const surface = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    surface.current?.querySelector<HTMLElement>('input, button')?.focus()
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={surface}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-fade-in w-full max-w-md rounded-lg border border-line bg-surface-1 shadow-2xl"
      >
        <h2 className="border-b border-line px-4 py-3 text-[13.5px] font-semibold text-ink">
          {title}
        </h2>
        <div className="px-4 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ misc */

export function Spinner({ className }: { className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      className={clsx('animate-spin', className)}
      aria-hidden="true"
      fill="none"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Empty / error / loading placeholder for a pane. */
export function Placeholder({
  icon,
  title,
  detail,
  action
}: {
  icon?: ReactNode
  title: string
  detail?: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      {icon ? <div className="text-ink-faint">{icon}</div> : null}
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {detail ? <p className="max-w-sm text-[12px] text-ink-muted">{detail}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/** A thin progress bar; `null` value renders an indeterminate sweep. */
export function ProgressBar({
  value,
  className
}: {
  value: number | null
  className?: string
}): ReactNode {
  return (
    <div className={clsx('h-1 overflow-hidden rounded-full bg-surface-3', className)}>
      {value === null ? (
        <div className="animate-indeterminate h-full w-1/3 rounded-full bg-brand" />
      ) : (
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-150"
          style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
        />
      )}
    </div>
  )
}
