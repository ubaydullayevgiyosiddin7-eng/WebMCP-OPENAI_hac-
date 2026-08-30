/**
 * The fact guard.
 *
 * An edit is queued only if every technology term, product name and number in
 * its new text is grounded — meaning it appears in a cited fact, or was already
 * in the block being rewritten. Anything else is refused with the offending
 * tokens named, so the agent can correct itself instead of retrying blindly.
 *
 * Grounding runs through the SAME alias layer as get_fit_gaps. A candidate whose
 * fact says "text to speech" and an agent that writes "TTS" must land on one
 * concept; otherwise the guard refuses a true claim, which is exactly as harmful
 * as passing a false one.
 *
 * What this guard does NOT do, stated plainly because the limit matters:
 * it checks that the *ingredients* of a sentence are attested, not that the
 * sentence as a whole is true. Every technology, number, name, superlative and
 * seniority claim can be individually grounded while the sentence still asserts
 * a combination no fact supports — "an OCR pipeline that reads fields from X-ray
 * scans" draws every token from two real facts that never met. Catching that
 * needs entailment, not token matching. scripts/guard-tests.mjs holds the case,
 * and it is expected to fail.
 */
import vocabulary from '../data/vocabulary.json'
import type { EditProposal, Fact, GuardFailure, ResumeBlock } from '../types'

const ALIAS_TO_CANONICAL = vocabulary.aliasToCanonical as Record<string, string>
const HYPHEN_GUARDED = new Set(vocabulary.hyphenGuarded as string[])
const ALL_ALIASES = Object.keys(ALIAS_TO_CANONICAL)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const reCache = new Map<string, RegExp>()
function termRe(term: string): RegExp {
  let re = reCache.get(term)
  if (!re) {
    const behind = HYPHEN_GUARDED.has(term) ? '(?<![a-z0-9-])' : '(?<![a-z0-9])'
    re = new RegExp(`${behind}${escapeRe(term)}(?![a-z0-9])`, 'i')
    reCache.set(term, re)
  }
  return re
}

/** Every canonical concept named anywhere in a piece of text. */
export function conceptsIn(text: string): Set<string> {
  const found = new Set<string>()
  for (const alias of ALL_ALIASES) {
    if (termRe(alias).test(text)) found.add(ALIAS_TO_CANONICAL[alias])
  }
  return found
}

/**
 * Numbers, normalised so "99.76%" and "99.76" are the same claim but "0.99" and
 * "0.994" are not. Rounding a metric is inventing a different metric.
 */
export function numbersIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    out.push(m[0].replace(',', '.').replace(/\.0+$/, ''))
  }
  // Spelled-out counts are the same claim as digits. "Shipped more than six
  // systems" becoming "more than twenty" slipped through while only digits were
  // scanned. "one" is excluded — it is far more often grammar than a count.
  for (const w of NUMBER_WORDS) {
    if (termRe(w).test(text)) out.push(w)
  }
  return out
}

const NUMBER_WORDS = [
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'fifteen', 'twenty', 'thirty', 'forty', 'fifty',
  'hundred', 'thousand', 'million', 'dozen',
]

/**
 * Claims that assert quality without asserting anything checkable. A metric
 * replaced by a superlative is still an inflated metric, and these are the exact
 * phrases a resume reaches for when the number will not support the sentence.
 */
const PUFFERY = [
  'near-perfect', 'near perfect', 'industry-leading', 'industry leading',
  'world-class', 'world class', 'best-in-class', 'state-of-the-art',
  'cutting-edge', 'unmatched', 'unparalleled', 'flawless', 'expert-level',
  'top-tier', 'pioneering', 'revolutionary', 'groundbreaking',
]

/**
 * Seniority and headcount claims. The absent-terms document names "team lead"
 * and "managed a team" as things this profile does not support, and an
 * unquantified "Led the team" carries the claim without tripping the number
 * check.
 */
const SENIORITY_CLAIMS = [
  'led', 'leads', 'leading', 'managed', 'manages', 'managing', 'headed',
  'heading', 'supervised', 'supervising', 'directed', 'directing',
  'mentored', 'mentoring', 'team of', 'head of', 'line managed',
]

/**
 * Capitalised words that read like names rather than sentence starts. Ordinary
 * English openers are ignored — the guard should refuse invented product names
 * and organisations, not the word "Built".
 */
const COMMON_CAPS = new Set(`
a an and or but so the this that these those there here it its i we our my me you your they their
at in on for from to of as by with without within across during over under after before between
also additionally currently previously including included such both more than most over around about
roughly approximately nearly almost up down out into per via using used use
built build building trained train training worked work working owned own led delivered shipped
developed designed implemented created ran running deployed improved reduced increased achieved
made built-in wrote writes integrated integrating combined combining maintained maintaining
first second third one two three four five six seven eight nine ten
years year months month days day team teams role position engineer engineering experience
production model models data set sets pipeline pipelines system systems project projects
detection classification recognition accuracy validation training inference deployment
customs border railway wagon vehicle document documents scans scan images image video
bachelor degree university institute programme program september january february march april
may june july august october november december
`.trim().split(/\s+/))

export function properNounsIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9+#.]*\b/g)) {
    const word = m[0]
    if (COMMON_CAPS.has(word.toLowerCase())) continue
    // Sentence-initial plain words are usually grammar, not names.
    const isAllCaps = word.length >= 2 && word === word.toUpperCase()
    const isCamel = /[a-z]/.test(word) && /[A-Z]/.test(word.slice(1))
    const atStart = m.index === 0 || /[.!?]\s+$/.test(text.slice(Math.max(0, m.index - 3), m.index))
    if (!isAllCaps && !isCamel && atStart) continue
    out.push(word)
  }
  return out
}

/** Everything the proposal is allowed to draw on. */
function groundingText(
  proposal: EditProposal,
  block: ResumeBlock,
  facts: Fact[],
): string {
  const cited = facts.filter((f) => proposal.sourceFactIds.includes(f.id))
  return [
    block.text,
    ...cited.map((f) => f.text),
    ...cited.flatMap((f) => f.tokens),
  ].join(' \n ')
}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ')

/**
 * Returns null when the edit is allowed, or a structured refusal naming the
 * tokens that could not be grounded.
 */
export function checkEdit(
  proposal: EditProposal,
  blocks: ResumeBlock[],
  facts: Fact[],
): GuardFailure | null {
  const fail = (reason: GuardFailure['reason'], offendingTokens: string[], hint: string): GuardFailure =>
    ({ targetBlockId: proposal.targetBlockId, reason, offendingTokens, hint })

  const block = blocks.find((b) => b.id === proposal.targetBlockId)
  if (!block) {
    return fail('unknown_block', [proposal.targetBlockId],
      'No resume block with that id. Call get_resume and use an id from its blocks.')
  }

  if (!proposal.sourceFactIds || proposal.sourceFactIds.length === 0) {
    return fail('no_source_facts', [],
      'Every edit must cite at least one fact id. Call get_profile_facts and cite what supports this wording.')
  }

  const known = new Set(facts.map((f) => f.id))
  const unknownFacts = proposal.sourceFactIds.filter((id) => !known.has(id))
  if (unknownFacts.length > 0) {
    return fail('unknown_fact', unknownFacts,
      'These fact ids do not exist. Cite ids returned by get_profile_facts.')
  }

  if (normalise(proposal.newText) === normalise(block.text)) {
    return fail('no_change', [],
      'The new text is the same as the current text apart from whitespace. Propose a real change or drop this edit.')
  }

  const grounding = groundingText(proposal, block, facts)
  const offending = ungroundedIn(proposal.newText, grounding)

  if (offending.length > 0) {
    return fail('unsupported_claim', offending,
      `Nothing in the cited facts or the original block supports: ${offending.join(', ')}. `
      + 'Either cite a fact that does, call request_profile_fact to ask the user to add one, or drop the claim.')
  }

  return null
}

/**
 * Everything in `text` that nothing in `grounding` supports.
 *
 * Shared by resume edits and the cover note. The note is part of what gets
 * sent, so holding it to a weaker standard than the resume would leave the
 * product's central claim — that the agent cannot lie on your behalf — true
 * only of the half of the payload that happens to be structured.
 */
export function ungroundedIn(text: string, grounding: string): string[] {
  // 1. Technology and product concepts, resolved through the alias table.
  const groundedConcepts = conceptsIn(grounding)
  const ungroundedConcepts = [...conceptsIn(text)].filter((c) => !groundedConcepts.has(c))

  // 2. Numbers. Exact match only — a rounded metric is a different metric.
  const groundedNumbers = new Set(numbersIn(grounding))
  const ungroundedNumbers = [...new Set(numbersIn(text))].filter((n) => !groundedNumbers.has(n))

  // 3. Names that appear nowhere in the cited material.
  //
  // A proper noun must appear LITERALLY, even when it is a known alias of a
  // grounded concept. "Whisper" resolves to the same concept as "TTS", so
  // exempting resolved aliases once let an agent name a specific model the
  // candidate never claimed. A grounded concept does not ground every product
  // that implements it.
  const groundLower = normalise(grounding)
  const ungroundedNames = [...new Set(properNounsIn(text))]
    .filter((w) => !groundLower.includes(w.toLowerCase()))

  // 4. Superlatives and seniority claims, neither of which a number check sees.
  const textLower = normalise(text)
  const ungroundedPuffery = PUFFERY.filter((x) => textLower.includes(x) && !groundLower.includes(x))
  const ungroundedSeniority = SENIORITY_CLAIMS.filter(
    (x) => termRe(x).test(text) && !termRe(x).test(grounding),
  )

  // Deduplicate case-insensitively: the same term otherwise appears twice, once
  // as the canonical concept and once as the surface spelling.
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of [
    ...ungroundedConcepts, ...ungroundedNumbers, ...ungroundedNames,
    ...ungroundedPuffery, ...ungroundedSeniority,
  ]) {
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * The cover note, held to the same standard as a resume block.
 *
 * Citing no facts is allowed here: a note that is pure connective prose —
 * "I would be glad to bring this work to your team" — asserts nothing and has
 * nothing to ground. The moment it names a technology, a number or a product,
 * a fact has to carry it.
 */
export function checkCoverNote(
  note: string,
  facts: Fact[],
  sourceFactIds: string[] = [],
): GuardFailure | null {
  const known = new Set(facts.map((f) => f.id))
  const unknown = sourceFactIds.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    return {
      targetBlockId: 'coverNote',
      reason: 'unknown_fact',
      offendingTokens: unknown,
      hint: 'These fact ids do not exist. Cite ids returned by get_profile_facts.',
    }
  }

  const cited = facts.filter((f) => sourceFactIds.includes(f.id))
  const grounding = [...cited.map((f) => f.text), ...cited.flatMap((f) => f.tokens)].join(' | ')
  const offending = ungroundedIn(note, grounding)
  if (offending.length === 0) return null

  return {
    targetBlockId: 'coverNote',
    reason: 'unsupported_claim',
    offendingTokens: offending,
    hint: `The cover note claims ${offending.join(', ')}, which no cited fact supports. `
      + 'Cite the fact ids that back it via sourceFactIds, or drop the claim. '
      + 'The note is sent alongside the resume and is held to the same standard.',
  }
}
