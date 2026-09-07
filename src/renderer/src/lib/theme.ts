/**
 * Theme application.
 *
 * Separate from `@shared/theme` because that module is also imported by the
 * build scripts, which run in Node and have no DOM types. The derivation logic
 * is shared; only the part that touches the document lives here.
 */
import { deriveTheme } from '@shared/theme'
import type { ThemeConfig } from '@shared/types'

export function applyTheme(theme: ThemeConfig, element: HTMLElement): void {
  for (const [name, value] of Object.entries(deriveTheme(theme))) {
    element.style.setProperty(`--${name}`, value)
  }
  // Tells the browser which built-in control colours to use, so native form
  // controls and scrollbars match the customer's palette.
  element.style.colorScheme = theme.mode
}
