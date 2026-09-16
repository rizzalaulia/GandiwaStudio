import { describe, expect, it } from 'vitest'

import type { GenerationReadyInput } from './generation-ready'
import {
  GENERATION_STOCK_CONSTRAINTS,
  KNOWN_IMAGE_GENERATION_PROVIDERS,
  evaluateGenerationReady,
} from './generation-ready'

const validBase = {
  prompt: 'Commercial lifestyle photo of a young barista pouring latte art in a sunlit cafe, generous copy space on the right',
  negativePrompt: 'logos, brand marks, watermark, text, letters, captions, UI elements, malformed hands, extra fingers, distorted face',
  provider: 'fal.ai' as const,
  model: 'fal-ai/flux/dev',
  contentType: 'photo' as const,
  creationMethod: 'generative_ai' as const,
  targetWidth: 2400,
  targetHeight: 1667,
  aspectRatio: '3:2',
  orientation: 'landscape' as const,
  stockConstraints: [...GENERATION_STOCK_CONSTRAINTS],
  negativeSpaceDecision: 'copy space reserved on the right third',
  modelCapabilities: { maxResolution: { width: 4096, height: 4096 } },
}

describe('evaluateGenerationReady', () => {
  it('passes a complete production brief', () => {
    const result = evaluateGenerationReady(validBase)
    expect(result.ready).toBe(true)
    expect(result.blockers).toEqual([])
    expect(result.megapixels).toBeCloseTo(4.0008, 3)
  })

  it('rejects an empty prompt', () => {
    const result = evaluateGenerationReady({ ...validBase, prompt: '   ' })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Prompt is required before generation.')
  })

  it('rejects a missing negative prompt', () => {
    const result = evaluateGenerationReady({ ...validBase, negativePrompt: '' })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Negative prompt is required before generation.')
  })

  it('rejects a provider that is not a known image-generation provider', () => {
    const result = evaluateGenerationReady({ ...validBase, provider: '9router' as GenerationReadyInput['provider'] })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Generation provider must be a known image-generation provider.')
  })

  it('accepts a future image-generation provider when it is registered', () => {
    const result = evaluateGenerationReady(
      { ...validBase, provider: 'futuregen' as GenerationReadyInput['provider'] },
      { knownProviders: [...KNOWN_IMAGE_GENERATION_PROVIDERS, 'futuregen'] },
    )
    expect(result.ready).toBe(true)
    expect(result.blockers).toEqual([])
  })

  it('rejects an empty model', () => {
    const result = evaluateGenerationReady({ ...validBase, model: '' })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('An explicit generation model is required.')
  })

  it('rejects when target resolution is below the 4 MP floor', () => {
    const result = evaluateGenerationReady({ ...validBase, targetWidth: 1920, targetHeight: 1080 })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Target resolution must be at least 4.0 MP (got 2.1 MP).')
  })

  it('rejects an aspect ratio that contradicts target dimensions', () => {
    const result = evaluateGenerationReady({ ...validBase, aspectRatio: '1:1' })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Aspect ratio 1:1 contradicts target dimensions 2400×1667.')
  })

  it('rejects a square ratio claimed as landscape', () => {
    const result = evaluateGenerationReady({
      ...validBase,
      aspectRatio: '1:1',
      targetWidth: 2000,
      targetHeight: 2000,
      orientation: 'landscape',
    })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Orientation must match the target aspect ratio.')
  })

  it('rejects when the selected model cannot reach the target resolution', () => {
    const result = evaluateGenerationReady({
      ...validBase,
      modelCapabilities: { maxResolution: { width: 1024, height: 1024 } },
    })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Selected model cannot reach the 2400×1667 target resolution.')
  })

  it('rejects incomplete stock constraints', () => {
    const result = evaluateGenerationReady({ ...validBase, stockConstraints: ['no_logo'] })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Stock constraints are incomplete: missing no_brand, no_watermark, no_random_text, no_fake_ui, no_unintentional_crop, no_malformed_anatomy, no_copyrighted_property.')
  })

  it('rejects a missing negative-space decision', () => {
    const result = evaluateGenerationReady({ ...validBase, negativeSpaceDecision: '' })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Negative-space decision must be recorded (or explicitly "none required").')
  })

  it('rejects unresolved prompt placeholders', () => {
    const result = evaluateGenerationReady({ ...validBase, prompt: 'A photo of {{subject}} in a cafe' })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('Prompt still contains unresolved placeholders: {{subject}}.')
  })

  it('rejects a creation method that contradicts a generative provider', () => {
    const result = evaluateGenerationReady({ ...validBase, creationMethod: 'camera' })
    expect(result.ready).toBe(false)
    expect(result.blockers).toContain('creation_method must be generative_ai (or mixed with disclosure) for a generated image.')
  })
})
