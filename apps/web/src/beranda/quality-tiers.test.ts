import { describe, expect, it } from 'vitest'

import {
  resolutionForTier,
  scaleForModelMax,
  tiers,
  type QualityTierId,
} from './quality-tiers'

// Issue #26 (opsi B) — quality tiers are the honest engine of Beranda's
// Medium/High/Max control: fixed MP floors, model-aware clamping, ratio
// preserved. Pure: no provider calls, no DOM.

describe('quality-tiers (Beranda Medium/High/Max)', () => {
  it('papers exactly three tiers onto the repo floor: 4/8/12 MP', () => {
    expect(tiers.map((tier) => tier.id)).toEqual<QualityTierId[]>(['medium', 'high', 'max'])
    expect(tiers.map((tier) => tier.megapixels)).toEqual([4, 8, 12])
    expect(tiers.every((tier) => tier.megapixels >= 4)).toBe(true)
  })

  it('resolves square-ish dimensions for a given tier and aspect ratio', () => {
    expect(resolutionForTier('medium', '1:1')).toEqual({ width: 2000, height: 2000 })
    expect(resolutionForTier('high', '1:1')).toEqual({ width: 2829, height: 2828 })
    expect(resolutionForTier('max', '1:1')).toEqual({ width: 3465, height: 3464 })
  })

  it('keeps classic stock ratios intact across tiers', () => {
    expect(resolutionForTier('medium', '3:2')).toEqual({ width: 2450, height: 1633 })
    expect(resolutionForTier('high', '16:9')).toEqual({ width: 3772, height: 2121 })
    expect(resolutionForTier('max', '4:5')).toEqual({ width: 3099, height: 3873 })
  })

  it('clamps to the model max while keeping the ratio, then reports what it did', () => {
    const exact = scaleForModelMax(2000, 2000, { width: 2000, height: 2000 })
    expect(exact).toEqual({ width: 2000, height: 2000, clamped: false })
    const over = scaleForModelMax(2828, 2828, { width: 2000, height: 2000 })
    expect(over).toEqual({ width: 2000, height: 2000, clamped: true })
    const wide = scaleForModelMax(3790, 2132, { width: 2800, height: 2800 })
    expect(wide).toEqual({ width: 2800, height: 1575, clamped: true })
  })
})
