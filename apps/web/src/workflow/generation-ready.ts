// Issue #58 — GENERATION_READY deterministic gate (slice 1).
//
// Pure and side-effect free: evaluates a generation brief and returns every
// blocking reason. fal.ai must never be called while `ready` is false.
// This gate validates the *target*; the deterministic raster pipeline later
// verifies the *actual* output file. It must never be renamed ADOBE_READY —
// that status only exists at the end of the Stage 4 evidence chain.

export const GENERATION_MIN_MEGAPIXELS = 4

// Image-generation providers known to Gandiwa. fal.ai is the only one wired up
// today; this list is the extension point when a second provider is chosen —
// do NOT hardcode the vendor inside the gate logic itself.
export const KNOWN_IMAGE_GENERATION_PROVIDERS = ['fal.ai'] as const

export type GenerationProvider = (typeof KNOWN_IMAGE_GENERATION_PROVIDERS)[number]

export const GENERATION_STOCK_CONSTRAINTS = [
  'no_logo',
  'no_brand',
  'no_watermark',
  'no_random_text',
  'no_fake_ui',
  'no_unintentional_crop',
  'no_malformed_anatomy',
  'no_copyrighted_property',
] as const

export type GenerationOrientation = 'landscape' | 'portrait' | 'square'

export type GenerationReadyOptions = Readonly<{
  /**
   * Providers recognized as image generators. Defaults to
   * KNOWN_IMAGE_GENERATION_PROVIDERS. Pass a wider list to trial a future
   * provider without editing gate logic.
   */
  knownProviders?: readonly string[]
}>

export type GenerationReadyInput = Readonly<{
  prompt: string
  negativePrompt: string
  provider: GenerationProvider
  model: string
  contentType: 'photo' | 'illustration' | 'vector'
  creationMethod: 'camera' | 'manual_digital' | 'generative_ai' | 'mixed'
  targetWidth: number
  targetHeight: number
  aspectRatio: string
  orientation: GenerationOrientation
  stockConstraints: readonly string[]
  negativeSpaceDecision: string
  modelCapabilities: Readonly<{ maxResolution: Readonly<{ width: number; height: number }> }>
}>

export type GenerationReadyResult = Readonly<{
  ready: boolean
  blockers: readonly string[]
  megapixels: number
}>

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g

function parseRatio(aspectRatio: string): { width: number; height: number } | null {
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(aspectRatio.trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

// Provider aspect parameters are coarse (e.g. "3:2" rendered at 2400×1667),
// so the declared ratio only needs to be within 5% of the target dimensions.
function ratioMatches(aspectRatio: string, width: number, height: number): boolean {
  const ratio = parseRatio(aspectRatio)
  if (!ratio) return false
  const declared = ratio.width / ratio.height
  const actual = width / height
  return Math.abs(actual - declared) / declared <= 0.05
}

function expectedOrientation(width: number, height: number): GenerationOrientation {
  if (width === height) return 'square'
  return width > height ? 'landscape' : 'portrait'
}

export function evaluateGenerationReady(
  input: GenerationReadyInput,
  options: GenerationReadyOptions = {},
): GenerationReadyResult {
  const blockers: string[] = []
  const megapixels = (input.targetWidth * input.targetHeight) / 1_000_000
  const knownProviders = options.knownProviders ?? KNOWN_IMAGE_GENERATION_PROVIDERS

  if (!input.prompt.trim()) blockers.push('Prompt is required before generation.')
  if (!input.negativePrompt.trim()) blockers.push('Negative prompt is required before generation.')
  if (!knownProviders.includes(input.provider)) blockers.push('Generation provider must be a known image-generation provider.')
  if (!input.model.trim()) blockers.push('An explicit generation model is required.')

  if (megapixels < GENERATION_MIN_MEGAPIXELS) {
    blockers.push(
      `Target resolution must be at least ${GENERATION_MIN_MEGAPIXELS.toFixed(1)} MP (got ${megapixels.toFixed(1)} MP).`,
    )
  } else if (!ratioMatches(input.aspectRatio, input.targetWidth, input.targetHeight)) {
    blockers.push(`Aspect ratio ${input.aspectRatio} contradicts target dimensions ${input.targetWidth}×${input.targetHeight}.`)
  }

  if (megapixels >= GENERATION_MIN_MEGAPIXELS && input.orientation !== expectedOrientation(input.targetWidth, input.targetHeight)) {
    blockers.push('Orientation must match the target aspect ratio.')
  }

  if (
    input.modelCapabilities.maxResolution.width < input.targetWidth
    || input.modelCapabilities.maxResolution.height < input.targetHeight
  ) {
    blockers.push(
      `Selected model cannot reach the ${input.targetWidth}×${input.targetHeight} target resolution.`,
    )
  }

  const missingConstraints = GENERATION_STOCK_CONSTRAINTS.filter(
    (constraint) => !input.stockConstraints.includes(constraint),
  )
  if (missingConstraints.length > 0) {
    blockers.push(`Stock constraints are incomplete: missing ${missingConstraints.join(', ')}.`)
  }

  if (!input.negativeSpaceDecision.trim()) {
    blockers.push('Negative-space decision must be recorded (or explicitly "none required").')
  }

  const placeholders = new Set<string>()
  for (const text of [input.prompt, input.negativePrompt]) {
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
      const name = match[1]?.trim()
      if (name) placeholders.add(`{{${name}}}`)
    }
  }
  if (placeholders.size > 0) {
    blockers.push(`Prompt still contains unresolved placeholders: ${[...placeholders].join(', ')}.`)
  }

  if (input.creationMethod !== 'generative_ai' && input.creationMethod !== 'mixed') {
    blockers.push('creation_method must be generative_ai (or mixed with disclosure) for a generated image.')
  }

  return { ready: blockers.length === 0, blockers, megapixels }
}
