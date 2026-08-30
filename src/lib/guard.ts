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
import type { BlockRef, EditProposal, Fact, GuardFailure, ResumeBlock } from '../types'

const ALIAS_TO_CANONICAL = vocabulary.aliasToCanonical as Record<string, string>
const HYPHEN_GUARDED = new Set(vocabulary.hyphenGuarded as string[])
const ALL_ALIASES = Object.keys(ALIAS_TO_CANONICAL)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const reCache = new Map<string, RegExp>()
function termRe(term: string): RegExp {
  let re = reCache.get(term)
  if (!re) {
    // "ray" must not match inside "X-ray" — nor inside "x ray", which the
    // hyphen guard alone missed and which an agent writes just as often.
    const behind = HYPHEN_GUARDED.has(term)
      ? String.raw`(?<![a-z0-9-])(?<!x[\s-])`
      : '(?<![a-z0-9])'
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


/** First words of a block, enough to tell two blocks apart at a glance. */
function preview(text: string, max = 58): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`
}

export const blockRefs = (blocks: ResumeBlock[]): BlockRef[] =>
  blocks.map((b) => ({ id: b.id, section: b.section, preview: preview(b.text) }))

const loosen = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * What a wrong id most plausibly meant.
 *
 * Agents reliably invent readable ids — "summary", "wagon-pipeline", "skills" —
 * rather than calling get_resume first. Naming the likely target turns a dead
 * end into one correctable retry. It is never applied automatically: the agent
 * re-sends, so the resume is only ever rewritten by an id someone chose.
 */
export function guessBlock(
  supplied: string,
  blocks: ResumeBlock[],
): { id: string } | { candidates: string[] } | null {
  const want = loosen(supplied)
  if (!want) return null

  // The id with its b_ / b_exp_ scaffolding removed: b_exp_wagon -> "wagon".
  const bare = (id: string) => loosen(id.replace(/^b_(exp_)?/, ''))

  const exact = blocks.filter((b) => bare(b.id) === want)
  if (exact.length === 1) return { id: exact[0].id }

  const partial = blocks.filter((b) => {
    const n = bare(b.id)
    return n.length > 2 && (want.includes(n) || n.includes(want))
  })
  if (partial.length === 1) return { id: partial[0].id }

  // A section name is not an id, but it does narrow the field.
  const bySection = blocks.filter((b) => loosen(b.section) === want)
  if (bySection.length === 1) return { id: bySection[0].id }
  if (bySection.length > 1) return { candidates: bySection.map((b) => b.id) }

  if (partial.length > 1) return { candidates: partial.map((b) => b.id) }

  // A typo in a real id — "b_sumary" — shares no useful substring, so fall back
  // to edit distance. Only a single close match counts; two equally close ones
  // are a guess, and guessing is what this function exists to replace.
  const scored = blocks
    .map((b) => ({ id: b.id, d: Math.min(distance(want, loosen(b.id)), distance(want, bare(b.id))) }))
    .sort((x, y) => x.d - y.d)
  const best = scored[0]
  if (best && best.d <= 2 && (scored.length < 2 || scored[1].d > best.d)) return { id: best.id }

  return null
}

/** Levenshtein, bounded by the short strings it is used on. */
function distance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length || !b.length) return Math.max(a.length, b.length)
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length]
}


/**
 * One surface form of a word, so that a claim and the fact backing it compare
 * equal when they differ only in how the word was written.
 *
 * A live session refused "CNNs" and "APIs" — both genuinely grounded, both
 * merely pluralised — because the check was a literal substring against the
 * fact text, which held "CNN" and "REST API". That is a false refusal, the one
 * failure class as damaging as a false pass.
 *
 * Where the line is drawn, deliberately narrowly:
 *   - case, possessives, and punctuation (hyphens, dots, slashes) are removed;
 *     "X-ray", "x ray" and "xray" are the same word, as are "PyTorch's" and
 *     "PyTorch".
 *   - a trailing plural -s is removed ONLY when three or more characters
 *     remain, which keeps AWS, GCP and RAG intact rather than reducing them to
 *     two-letter stems that could collide with something else.
 *   - nothing else. No stemming, no prefix matching, no edit distance. Those
 *     would let "Kubernetes" reach a grounded word, and the whole point is that
 *     it must not. "Kubernetes" normalises to "kubernete", which appears in no
 *     fact this profile contains, so it is still refused.
 */
export function normWord(w: string): string {
  const base = String(w).toLowerCase()
    .replace(/['‘’`]s$/, '')
    .replace(/[^a-z0-9+#]/g, '')
  if (!base.endsWith('s')) return base
  const singular = base.slice(0, -1)
  return singular.length >= 3 ? singular : base
}

/** Every word the cited material contains, in that same single form. */
function groundedWords(grounding: string): Set<string> {
  const out = new Set<string>()
  for (const raw of grounding.split(/[^A-Za-z0-9+#'’]+/)) {
    if (!raw) continue
    out.add(normWord(raw))
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
    ({ targetBlockId: proposal.targetBlockId, reason, offendingTokens, hint, message: hint })

  const block = blocks.find((b) => b.id === proposal.targetBlockId)
  if (!block) {
    const refs = blockRefs(blocks)
    const idList = refs.map((r) => r.id).join(', ')
    const supplied = String(proposal.targetBlockId ?? '')
    const guess = guessBlock(supplied, blocks)

    let message: string
    let didYouMean: string | null = null

    // The message stays specific to this edit; the full id list is stated once
    // by the caller. Repeating fourteen ids per rejection buries the correction.
    if (!supplied.trim()) {
      message = 'targetBlockId was empty.'
    } else if (guess && 'id' in guess) {
      didYouMean = guess.id
      message = `"${supplied}" is not a block id — you most likely meant "${guess.id}". Re-send with that id.`
    } else if (guess && 'candidates' in guess) {
      message = `"${supplied}" is a section, not a block id; it covers `
        + `${guess.candidates.length} blocks (${guess.candidates.join(', ')}). Pick one.`
    } else {
      message = `"${supplied}" is not a block id.`
    }

    return {
      targetBlockId: proposal.targetBlockId,
      reason: 'unknown_block',
      offendingTokens: [proposal.targetBlockId],
      message,
      // The aggregate summary states the id list once; this per-failure hint
      // repeats it so a single rejection is self-sufficient on its own.
      hint: `${message} Block ids are assigned by the app and cannot be derived from the `
        + 'section name or the text — get_resume returns them alongside each block. '
        + `Valid ids: ${idList}.`,
      validBlocks: refs,
      didYouMean,
    }
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
 * grounding constraint holding over only the structured half of the payload.
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
  const groundWords = groundedWords(grounding)
  const ungroundedNames = [...new Set(properNounsIn(text))]
    .filter((w) => !groundWords.has(normWord(w)))

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
      message: `These fact ids do not exist: ${unknown.join(', ')}.`,
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
    message: `The cover note claims ${offending.join(', ')}, which no cited fact supports.`,
    hint: `The cover note claims ${offending.join(', ')}, which no cited fact supports. `
      + 'Cite the fact ids that back it via sourceFactIds, or drop the claim. '
      + 'The note is sent alongside the resume and is held to the same standard.',
  }
}

/**
 * How many distinct pieces of work a proposed sentence draws on.
 *
 * Token matching cannot see entailment: "an OCR pipeline that reads fields from
 * X-ray scans" takes every token from two real facts that never met, and each
 * ingredient checks out. Rather than pretend to catch that, or block a
 * legitimate summary sentence, we make it visible — the human is the final
 * check, and the guard's job is to show them what actually needs checking.
 *
 * Projects are grouped by fact-id stem, so the three wagon-pipeline facts count
 * as one piece of work while the wagon pipeline and the X-ray classifier count
 * as two. Only achievements are grouped: skills are attributes of the candidate,
 * not separate projects, and citing several of them is ordinary.
 */
export function sourceSpread(sourceFactIds: string[], facts: Fact[]): {
  groups: string[]
  combines: number
} {
  const groups = new Set<string>()
  for (const id of sourceFactIds) {
    const fact = facts.find((f) => f.id === id)
    if (!fact || fact.kind !== 'achievement') continue
    groups.add(id.split('_').slice(0, 2).join('_'))
  }
  return { groups: [...groups], combines: groups.size }
}
