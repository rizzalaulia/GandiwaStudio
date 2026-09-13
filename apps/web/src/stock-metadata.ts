export type ReleaseStatus = 'not_required' | 'attached' | 'needs_review'
export type MetadataContentType = 'photo' | 'illustration' | 'vector'
export type MetadataCreationMethod = 'camera' | 'manual_digital' | 'generative_ai' | 'mixed'

export type StockMetadataDraft = Readonly<{
  schemaVersion: 1
  title: string
  keywords: readonly string[]
  category: string
  contentType: MetadataContentType
  creationMethod: MetadataCreationMethod
  generatedWithAi: boolean
  aiDisclosure: string
  releaseStatus: ReleaseStatus
}>

export type StockMetadataAssessment = Readonly<{
  valid: boolean
  errors: readonly string[]
  warnings: readonly string[]
}>

export type AssetProvenance = Readonly<{
  contentType: MetadataContentType
  creationMethod: MetadataCreationMethod
}>

const BRAND_TERMS = ['adobe', 'apple', 'coca-cola', 'nike', 'google', 'microsoft']
const ARTIST_TERMS = ['frida kahlo', 'picasso', 'van gogh', 'banksy', 'disney']

export function normalizeStockMetadata(draft: StockMetadataDraft): StockMetadataDraft {
  const keywords: string[] = []
  const seen = new Set<string>()
  for (const raw of draft.keywords) {
    const keyword = raw.trim()
    const key = keyword.toLocaleLowerCase()
    if (keyword && !seen.has(key)) {
      seen.add(key)
      keywords.push(keyword)
    }
  }
  return { ...draft, title: draft.title.trim(), category: draft.category.trim(), aiDisclosure: draft.aiDisclosure.trim(), keywords }
}

function warningTerms(text: string, terms: readonly string[], label: string): readonly string[] {
  return terms.filter((term) => text.includes(term)).map((term) => `Possible ${label} term “${term}” needs human review.`)
}

export function isStockMetadataDraft(value: unknown): value is StockMetadataDraft {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === 1
    && typeof record.title === 'string'
    && Array.isArray(record.keywords) && record.keywords.every((keyword) => typeof keyword === 'string')
    && typeof record.category === 'string'
    && ['photo', 'illustration', 'vector'].includes(record.contentType as string)
    && ['camera', 'manual_digital', 'generative_ai', 'mixed'].includes(record.creationMethod as string)
    && typeof record.generatedWithAi === 'boolean'
    && typeof record.aiDisclosure === 'string'
    && ['not_required', 'attached', 'needs_review'].includes(record.releaseStatus as string)
}

export function assessStockMetadata(raw: StockMetadataDraft, provenance?: AssetProvenance): StockMetadataAssessment {
  const draft = normalizeStockMetadata(raw)
  const errors: string[] = []
  if (!draft.title) errors.push('Title is required.')
  if (!draft.category) errors.push('Category is required.')
  if (draft.keywords.length < 5) errors.push('At least five keywords are required.')
  if (!draft.releaseStatus) errors.push('Release status is required.')
  if ((draft.generatedWithAi || draft.creationMethod === 'generative_ai' || provenance?.creationMethod === 'generative_ai') && !draft.aiDisclosure) errors.push('AI-generated work requires an AI disclosure.')
  const allText = `${draft.title} ${draft.keywords.join(' ')}`.toLocaleLowerCase()
  const warnings = [...warningTerms(allText, BRAND_TERMS, 'brand'), ...warningTerms(allText, ARTIST_TERMS, 'artist')]
  if (provenance && draft.contentType !== provenance.contentType) warnings.push('Submission content type differs from immutable asset provenance; review before submission.')
  if (provenance && draft.creationMethod !== provenance.creationMethod) warnings.push('Submission creation method differs from immutable asset provenance; review AI disclosure before submission.')
  return { valid: errors.length === 0, errors, warnings }
}
