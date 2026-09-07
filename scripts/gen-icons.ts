/**
 * Icon generation for a customer build.
 *
 * Turns the customer's square source PNG into the .ico / .icns / .png set
 * electron-builder expects. If a customer has not supplied an icon yet, a
 * placeholder is drawn from their brand colours so the build still produces a
 * recognisably-theirs binary rather than the default Electron atom.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import png2icons from 'png2icons'
import { deriveTheme } from '../src/shared/theme'
import { Canvas, hexToRgb, roundedRect } from './png'
import type { LoadedCustomer } from './customer'

const SIZE = 1024

/** A waveform mark on a rounded-square field, in the customer's brand colours. */
export function drawPlaceholderIcon(loaded: LoadedCustomer): Buffer {
  const vars = deriveTheme(loaded.config.theme)
  const bg = hexToRgb(vars.primary!)
  const fg = hexToRgb(vars['primary-fg']!)
  const canvas = new Canvas(SIZE, SIZE)
  const c = SIZE / 2

  canvas.fill(roundedRect(c, c, SIZE / 2 - 8, SIZE / 2 - 8, 208), bg)

  // Five bars of varying height, evenly spaced, reading as an audio waveform.
  const heights = [0.30, 0.62, 0.44, 0.86, 0.36]
  const barW = 78
  const gap = 46
  const totalW = heights.length * barW + (heights.length - 1) * gap
  heights.forEach((h, i) => {
    const x = c - totalW / 2 + barW / 2 + i * (barW + gap)
    const halfH = (SIZE * 0.62 * h) / 2
    canvas.fill(roundedRect(x, c, barW / 2, halfH, barW / 2), fg)
  })

  return canvas.toPng()
}

/** Write a placeholder to the configured icon path if none exists. */
export function ensureSourceIcon(loaded: LoadedCustomer): Buffer {
  if (existsSync(loaded.iconPath)) return readFileSync(loaded.iconPath)
  mkdirSync(join(loaded.iconPath, '..'), { recursive: true })
  const png = drawPlaceholderIcon(loaded)
  writeFileSync(loaded.iconPath, png)
  console.log(`  generated placeholder icon -> ${loaded.config.theme.icon}`)
  return png
}

export interface IconSet {
  dir: string
  png: string
  ico: string
  icns: string
}

/**
 * Produce `build/<id>/icon.{png,ico,icns}`. electron-builder picks the right one
 * per target from the directory, so all three are written regardless of which
 * platform this build is for - that keeps the CI matrix from needing a special
 * case per runner.
 */
export function generateIconSet(loaded: LoadedCustomer, outDir: string): IconSet {
  const source = ensureSourceIcon(loaded)
  mkdirSync(outDir, { recursive: true })

  const png = join(outDir, 'icon.png')
  const ico = join(outDir, 'icon.ico')
  const icns = join(outDir, 'icon.icns')

  writeFileSync(png, source)

  const icoBuf = png2icons.createICO(source, png2icons.BILINEAR, 0, false, true)
  if (!icoBuf) throw new Error(`Could not build an .ico from ${loaded.config.theme.icon}`)
  writeFileSync(ico, icoBuf)

  const icnsBuf = png2icons.createICNS(source, png2icons.BILINEAR, 0)
  if (!icnsBuf) throw new Error(`Could not build an .icns from ${loaded.config.theme.icon}`)
  writeFileSync(icns, icnsBuf)

  return { dir: outDir, png, ico, icns }
}
