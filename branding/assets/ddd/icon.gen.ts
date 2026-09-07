/**
 * Doodoo Dynamics icon, drawn rather than traced.
 *
 * Lives beside the asset it produces rather than in `scripts/` because it is
 * customer artwork, not build tooling - nothing in the build depends on it.
 * Re-run it after changing the palette or the silhouette:
 *
 *   npx tsx branding/assets/ddd/icon.gen.ts
 *
 * The mark is a soft-serve swirl: a stack of ellipses fused with a smooth
 * union, leaning right as it rises. Deliberately no wordmark and no cartoon
 * eyes - an app icon is rendered at 16-32px in a taskbar, where text turns to
 * mush and a clean silhouette still reads.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Canvas, ellipse, hexToRgb, roundedRect, smoothUnion } from '../../../scripts/png'

/** Sampled from the reference artwork so the icon and logo agree exactly. */
const CREAM = '#FFFCF7'
const BROWN = '#552E0D'

/** Nominal design size. All coordinates below are in this space. */
const SIZE = 1024

/**
 * Swirl tiers as `[cx, cy, rx, ry]`.
 *
 * Each is wider than tall and sits above the last, shrinking and drifting right
 * so the stack tapers into a lean. The blend radius below is what turns these
 * six discs into one continuous form.
 */
const TIERS: Array<[number, number, number, number]> = [
  [500, 742, 268, 122],
  [522, 566, 203, 107],
  [548, 414, 140, 90],
  [572, 296, 80, 70],
  [592, 218, 33, 38]
]

/**
 * Blend radius.
 *
 * The tuning that matters. Too large and the tiers dissolve into a smooth cone;
 * the silhouette has to keep a visible waist where each tier overhangs the one
 * above, because that scalloped profile is the whole shape.
 */
const BLEND = 16

/**
 * How much of the frame the mark fills, about the optical centre.
 *
 * Icons are read at 16-32px in a taskbar, where generous padding just makes the
 * subject smaller than it needs to be. ~60% of the width is about right.
 */
const SCALE = 1.15
/** Vertical centre of the mark's mass, which is below the canvas centre. */
const MARK_CENTRE_Y = 522

/**
 * Render at `size` pixels square.
 *
 * Rendering small sizes directly from the vector definition, rather than
 * downsampling the 1024 bitmap, is how you find out whether the silhouette
 * survives at 16px - which is the size that actually matters in a taskbar.
 */
export function drawIcon(size = SIZE): Buffer {
  const k = size / SIZE
  const canvas = new Canvas(size, size)
  const centre = size / 2

  // Cream field, inset slightly so the rounded corners are not clipped.
  canvas.fill(roundedRect(centre, centre, centre - 8 * k, centre - 8 * k, 208 * k), hexToRgb(CREAM))

  const scaled = TIERS.map(([cx, cy, rx, ry]) =>
    ellipse(
      centre + (cx - SIZE / 2) * SCALE * k,
      (MARK_CENTRE_Y + (cy - MARK_CENTRE_Y) * SCALE) * k,
      rx * SCALE * k,
      ry * SCALE * k
    )
  )
  canvas.fill(smoothUnion(BLEND * SCALE * k, ...scaled), hexToRgb(BROWN))

  return canvas.toPng()
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (invokedDirectly) {
  const target = join(import.meta.dirname, 'icon.png')
  writeFileSync(target, drawIcon())
  console.log(`Wrote ${target} (${SIZE}x${SIZE})`)
}
