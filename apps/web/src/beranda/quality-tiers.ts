// Issue #26 (opsi B) — Beranda quality tiers.
// Medium/High/Max are honest MP floors from the repo's 4 MP stock gate:
//   medium = 4 MP (the floor itself), high = 8 MP, max = 12 MP.
// The rule is exact math, no magic digits: width = round(sqrt(pixels·w/h)),
// height = round(pixels/width). The pixel count always lands AT or ABOVE the
// tier floor (the gate compares >=), and the aspect ratio is preserved.
// Providers may still snap to their own allowed sizes — that difference is
// exactly what "target vs actual pixels" labels must surface later.

export type QualityTierId = 'medium' | 'high' | 'max'

export type QualityTier = Readonly<{
  id: QualityTierId
  label: string
  megapixels: number
}>

export const tiers: readonly QualityTier[] = [
  { id: 'medium', label: 'Medium', megapixels: 4 },
  { id: 'high', label: 'High', megapixels: 8 },
  { id: 'max', label: 'Max', megapixels: 12 },
] as const

const TIER_BY_ID = new Map(tiers.map((tier) => [tier.id, tier]))

/** Canonical stock ratios Beranda offers in the prompt layout. */
export const ASPECT_RATIOS: readonly { id: string; w: number; h: number }[] = [
  { id: '1:1', w: 1, h: 1 },
  { id: '3:2', w: 3, h: 2 },
  { id: '2:3', w: 2, h: 3 },
  { id: '4:3', w: 4, h: 3 },
  { id: '3:4', w: 3, h: 4 },
  { id: '16:9', w: 16, h: 9 },
  { id: '9:16', w: 9, h: 16 },
  { id: '4:5', w: 4, h: 5 },
  { id: '5:4', w: 5, h: 4 },
]

function ratioParts(ratio: string): [number, number] {
  const known = ASPECT_RATIOS.find((entry) => entry.id === ratio)
  if (known) return [known.w, known.h]
  const parts = ratio.split(':').map((part) => Number.parseInt(part, 10))
  const w = parts[0] ?? 1
  const h = parts[1] ?? 1
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return [w, h]
  return [1, 1]
}

export function resolutionForTier(tierId: QualityTierId, ratio: string): { width: number; height: number } {
  const tier = TIER_BY_ID.get(tierId) ?? TIER_BY_ID.get('medium')!
  const pixels = tier.megapixels * 1_000_000
  const [rw, rh] = ratioParts(ratio)
  // Ceil-then-guard: rounding down could dip under the tier floor
  // (2449x1633 = 3.999 MP fails a 4 MP gate). Round up first, then nudge
  // the height until the product honestly clears the floor.
  const width = Math.ceil(Math.sqrt((pixels * rw) / rh))
  let height = Math.ceil(pixels / width)
  while (width * height < pixels) {
    height += 1
  }
  return { width, height }
}

export function scaleForModelMax(
  width: number,
  height: number,
  modelMax: Readonly<{ width: number; height: number }>,
): { width: number; height: number; clamped: boolean } {
  if (width <= modelMax.width && height <= modelMax.height) {
    return { width, height, clamped: false }
  }
  const scale = Math.min(modelMax.width / width, modelMax.height / height)
  return { width: Math.round(width * scale), height: Math.round(height * scale), clamped: true }
}
