import { describe, expect, it } from 'vitest'

import { assessStockMetadata, normalizeStockMetadata, type StockMetadataDraft } from './stock-metadata'

const valid = (): StockMetadataDraft => ({
  schemaVersion: 1,
  title: 'Golden sunrise over a quiet mountain lake',
  keywords: ['sunrise', 'mountain', 'lake', 'landscape', 'nature'],
  category: 'Landscapes',
  contentType: 'illustration',
  creationMethod: 'manual_digital',
  generatedWithAi: false,
  aiDisclosure: '',
  releaseStatus: 'not_required',
})

describe('stock metadata contract', () => {
  it('normalizes editable title and keywords while preserving their order', () => {
    expect(normalizeStockMetadata({ ...valid(), title: '  Golden sunrise  ', keywords: [' sunrise ', 'mountain', 'sunrise', 'lake', 'landscape', 'nature'] })).toMatchObject({
      title: 'Golden sunrise',
      keywords: ['sunrise', 'mountain', 'lake', 'landscape', 'nature'],
    })
  })

  it('blocks AI-generated work without an AI disclosure', () => {
    const result = assessStockMetadata({ ...valid(), generatedWithAi: true })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('AI-generated work requires an AI disclosure.')
  })

  it('blocks a generative-AI creation method without an AI disclosure', () => {
    const result = assessStockMetadata({ ...valid(), creationMethod: 'generative_ai' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('AI-generated work requires an AI disclosure.')
  })

  it('requires disclosure from immutable generative-AI provenance and warns on a conflicting declaration', () => {
    const result = assessStockMetadata({ ...valid(), creationMethod: 'camera' }, { contentType: 'photo', creationMethod: 'generative_ai' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('AI-generated work requires an AI disclosure.')
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/content type differs/i),
      expect.stringMatching(/creation method differs/i),
    ]))
  })

  it('requires title, category, at least five keywords, and a release decision', () => {
    const result = assessStockMetadata({ ...valid(), title: ' ', category: '', keywords: ['one'], releaseStatus: '' as never })
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      'Title is required.',
      'Category is required.',
      'At least five keywords are required.',
      'Release status is required.',
    ]))
  })

  it('keeps brand and artist terms as recommendations rather than deterministic blocks', () => {
    const result = assessStockMetadata({ ...valid(), title: 'Nike inspired portrait in the style of Frida Kahlo', keywords: ['Nike', 'Frida Kahlo', 'portrait', 'art', 'woman'] })
    expect(result.valid).toBe(true)
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/brand/i),
      expect.stringMatching(/artist/i),
    ]))
  })
})
