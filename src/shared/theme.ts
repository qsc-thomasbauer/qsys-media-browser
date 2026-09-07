/**
 * Theme derivation.
 *
 * A customer supplies two or three brand colours; everything the UI needs
 * (raised surfaces, borders, muted text, hover and active states, "subtle"
 * tinted backgrounds, and readable foregrounds for coloured buttons) is derived
 * from those in OKLCH so the steps are perceptually even regardless of hue.
 *
 * Foreground colours are *computed* to satisfy WCAG AA rather than guessed, so
 * a dark brand colour cannot produce unreadable button labels. The one thing we
 * refuse to fix silently is a brand colour that is indistinguishable from its
 * own background - that needs a human decision, so it fails the build.
 */
import { converter, formatHex, interpolate, clampChroma, wcagContrast, parse } from 'culori'
import type { ThemeConfig } from '../../branding/_schema'

const toOklch = converter('oklch')

/** WCAG AA for body text. */
export const AA_TEXT = 4.5
/** WCAG 1.4.11 for UI component boundaries and graphical objects. */
export const AA_UI = 3.0

type Oklch = { mode: 'oklch'; l: number; c: number; h?: number; alpha?: number }

function oklch(color: string): Oklch {
  const parsed = toOklch(color)
  if (!parsed) throw new Error(`Not a parseable colour: ${color}`)
  return parsed as Oklch
}

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n))

/** Serialise back to a hex string, pulling out-of-gamut chroma back in first. */
function hex(color: Oklch): string {
  return formatHex(clampChroma(color, 'oklch')) ?? '#000000'
}

/** Shift lightness by `delta` (OKLCH L is 0..1). */
function shiftL(color: Oklch, delta: number): Oklch {
  return { ...color, l: clamp(color.l + delta) }
}

/** Blend `amount` of `to` into `from` through OKLCH. */
function mix(from: string, to: string, amount: number): string {
  const at = interpolate([from, to], 'oklch')(clamp(amount))
  return formatHex(clampChroma(at, 'oklch')) ?? from
}

/** Contrast ratio, normalised to a number so callers need no null checks. */
function contrast(a: string, b: string): number {
  return wcagContrast(a, b) ?? 0
}

/** Lowest contrast `fg` achieves against any of the surfaces it appears on. */
function worstContrast(fg: string, backgrounds: string[]): number {
  return Math.min(...backgrounds.map((bg) => contrast(fg, bg)))
}

/**
 * Push `fg` in a fixed direction until it clears `target` against *every*
 * background it will sit on.
 *
 * The direction is passed in rather than inferred from the background, because
 * inferring it per-background is what breaks on a mid-lightness surface: the
 * ramp's darkest and lightest ends disagree about which way is "away", and a
 * text colour chosen for one end can then fail the other. In dark mode text is
 * always lighter; in light mode always darker.
 *
 * Returns the best candidate found; whether a shortfall is fatal is the
 * caller's decision (`deriveTheme` shrinks the surface ramp, `validateTheme`
 * reports).
 */
function ensureContrast(
  fg: string,
  backgrounds: string | string[],
  target: number,
  direction: 'lighter' | 'darker'
): string {
  const list = Array.isArray(backgrounds) ? backgrounds : [backgrounds]
  if (worstContrast(fg, list) >= target) return fg

  const base = oklch(fg)
  const sign = direction === 'lighter' ? 1 : -1
  let best = fg
  let bestRatio = worstContrast(fg, list)

  for (let step = 1; step <= 40; step++) {
    const candidate = hex(shiftL(base, sign * step * 0.025))
    const ratio = worstContrast(candidate, list)
    if (ratio > bestRatio) {
      bestRatio = ratio
      best = candidate
    }
    if (ratio >= target) return candidate
  }

  // Last resort: the extreme in the chosen direction.
  const extreme = direction === 'lighter' ? '#ffffff' : '#000000'
  return worstContrast(extreme, list) > bestRatio ? extreme : best
}

/**
 * The readable foreground for a filled swatch - a tinted white or black.
 *
 * Unlike body text, the direction here *is* chosen per swatch: a button label
 * has exactly one background, so whichever of white or black reads better on
 * the brand colour is simply the right answer.
 */
function foregroundFor(bg: string): string {
  const b = oklch(bg)
  const light = hex({ mode: 'oklch', l: 0.98, c: Math.min(b.c, 0.03), h: b.h })
  const dark = hex({ mode: 'oklch', l: 0.16, c: Math.min(b.c, 0.04), h: b.h })
  const preferLight = contrast(light, bg) >= contrast(dark, bg)
  return ensureContrast(
    preferLight ? light : dark,
    bg,
    AA_TEXT,
    preferLight ? 'lighter' : 'darker'
  )
}

/** The full set of CSS custom properties, keyed without the leading dashes. */
export type ThemeVars = Record<string, string>

export function deriveTheme(theme: ThemeConfig): ThemeVars {
  const dark = theme.mode === 'dark'
  /** Direction in which "raised" surfaces move. */
  const up = dark ? 1 : -1

  const surface = oklch(theme.colors.surface)
  const primary = theme.colors.primary
  const primaryO = oklch(primary)

  const accent = theme.colors.accent ?? hex({ ...primaryO, h: ((primaryO.h ?? 0) + 42) % 360 })
  const danger = theme.colors.danger ?? (dark ? '#f2555a' : '#c8262c')

  /** Text always moves away from the surface in the direction the mode implies. */
  const textDirection = dark ? 'lighter' : 'darker'
  const textSeed = dark
    ? hex({ mode: 'oklch', l: 0.97, c: Math.min(surface.c, 0.012), h: surface.h })
    : hex({ mode: 'oklch', l: 0.2, c: Math.min(surface.c, 0.016), h: surface.h })

  /**
   * Build the surface ramp, shrinking its span until one text colour is legible
   * on *every* step of it.
   *
   * The naive fixed ramp fails on a mid-lightness surface: raising it by 0.125
   * OKLCH can lift the topmost surface past the point where near-white text
   * still clears AA, while the base is dark enough that near-black text fails
   * too. Rather than pick a text colour that is wrong somewhere, flatten the
   * ramp - the visual hierarchy loses a little contrast, the text stays
   * readable. If even a zero-span ramp cannot carry legible text, the surface
   * colour is genuinely unusable for this mode and `validateTheme` says so.
   */
  const steps = [0, 0.045, 0.085, 0.125] as const
  let surfaces: string[] = []
  let text = textSeed
  for (let attempt = 0; attempt <= 6; attempt++) {
    const scale = 0.55 ** attempt
    surfaces = steps.map((step) => hex(shiftL(surface, up * step * scale)))
    text = ensureContrast(textSeed, surfaces, AA_TEXT, textDirection)
    if (worstContrast(text, surfaces) >= AA_TEXT) break
  }

  const [surface0, surface1, surface2, surface3] = surfaces as [string, string, string, string]

  // Muted and faint variants move back toward the surface, then are corrected
  // against every surface they can appear on - the same all-backgrounds rule.
  const textMuted = ensureContrast(
    hex(shiftL(oklch(text), dark ? -0.24 : 0.26)),
    surfaces,
    AA_TEXT,
    textDirection
  )
  const textFaint = ensureContrast(
    hex(shiftL(oklch(text), dark ? -0.36 : 0.38)),
    surfaces,
    AA_UI,
    textDirection
  )

  return {
    'surface-0': surface0,
    'surface-1': surface1,
    'surface-2': surface2,
    'surface-3': surface3,

    border: mix(surface1, text, dark ? 0.14 : 0.16),
    'border-strong': mix(surface1, text, dark ? 0.28 : 0.32),

    text,
    'text-muted': textMuted,
    'text-faint': textFaint,

    primary,
    'primary-hover': hex(shiftL(primaryO, dark ? 0.05 : -0.05)),
    'primary-active': hex(shiftL(primaryO, dark ? -0.05 : 0.05)),
    'primary-subtle': mix(surface0, primary, dark ? 0.2 : 0.14),
    'primary-fg': foregroundFor(primary),

    accent,
    'accent-subtle': mix(surface0, accent, dark ? 0.2 : 0.14),
    'accent-fg': foregroundFor(accent),

    danger,
    'danger-hover': hex(shiftL(oklch(danger), dark ? 0.05 : -0.05)),
    'danger-subtle': mix(surface0, danger, dark ? 0.2 : 0.14),
    'danger-fg': foregroundFor(danger),

    /** Focus ring: the brand colour, lifted until it reads against any surface. */
    ring: ensureContrast(primary, [surface0, surface3], AA_UI, dark ? 'lighter' : 'darker')
  }
}

export interface ContrastProblem {
  pair: string
  ratio: number
  required: number
  hint: string
}

/**
 * Hard failures only - pairs that cannot be fixed without changing the brand
 * colours themselves. Derived foregrounds are already corrected by
 * `deriveTheme`, so anything reported here is a genuine config problem.
 */
export function validateTheme(theme: ThemeConfig): ContrastProblem[] {
  for (const [key, value] of Object.entries(theme.colors)) {
    if (value && !parse(value)) {
      throw new Error(`theme.colors.${key} is not a parseable colour: ${value}`)
    }
  }

  const vars = deriveTheme(theme)
  const problems: ContrastProblem[] = []
  const check = (pair: string, fg: string, bg: string, required: number, hint: string): void => {
    const ratio = contrast(fg, bg)
    if (ratio < required) {
      problems.push({ pair, ratio: Math.round(ratio * 100) / 100, required, hint })
    }
  }

  check(
    'primary on surface',
    vars.primary!,
    vars['surface-0']!,
    AA_UI,
    'the brand colour is too close to the surface colour to read as a button or focus ring; lighten or darken one of them'
  )
  check(
    'text on surface',
    vars.text!,
    vars['surface-3']!,
    AA_TEXT,
    'no readable text colour exists for this surface; move theme.colors.surface further from mid-grey'
  )
  check(
    'danger on surface',
    vars.danger!,
    vars['surface-0']!,
    AA_UI,
    'destructive actions would be invisible; set an explicit theme.colors.danger'
  )
  return problems
}
