/**
 * Tailor — job data fetcher
 *
 * Builds src/data/jobs.json: the job board the tailoring agent reads through its
 * WebMCP tools. Run:  npm run fetch-jobs
 *
 * Sources (all free, no API key, Node's built-in fetch only)
 *   Jobicy     https://jobicy.com/api/v2/remote-jobs        remote-only, tag-queryable
 *   Himalayas  https://himalayas.app/jobs/api               remote-only, offset-paginated
 *   Arbeitnow  https://www.arbeitnow.com/api/job-board-api  ATS-sourced, mostly EU on-site
 *   Remotive   https://remotive.com/api/remote-jobs         remote-only, badly degraded
 *
 * Every row keeps a `source` field so the UI can attribute it, and a canonical
 * `url`. We store a truncated description — the full posting text stays on the
 * original site. We link out, we do not republish.
 *
 * Matching rules, and why they are what they are:
 *
 *   1. Relevance is decided by the JOB TITLE, not by a "machine learning" mention
 *      buried in a description. That is what keeps full-stack postings that
 *      name-drop ML out of the board.
 *
 *   2. Titles and tags are matched on WORD BOUNDARIES, never bare substrings.
 *      Substring matching is what produced an early dataset's garbage: "rag"
 *      matched Auftrag / storage / leverage, "git" matched digital, "ocr" matched
 *      democratise, and "llm" matched Fulfillment. Product managers and COOs were
 *      landing on an ML job board tagged as RAG engineers.
 *
 *   3. A posting must carry at least one core ML tag, plus a minimum of three
 *      tags overall, so a title alone cannot carry a row.
 *
 *   4. Titles that are really front-end, full-stack, product, or sales roles are
 *      rejected outright even if they mention AI.
 *
 *   5. EVERY TAG CARRIES ITS EVIDENCE. A tag is {tag, evidence, required}, where
 *      evidence is the ~140-character window of the real posting the match came
 *      from. The stored description is truncated, so without this a tag could be
 *      true of the posting yet unverifiable in the app — and an unverifiable
 *      claim is the exact failure mode this product exists to prevent. A derived
 *      `tagNames` array is kept alongside so filtering stays cheap.
 *
 * Source notes, all established by probing rather than by reading docs:
 *
 *   Remotive  — its public API now ignores search, category and limit; every
 *               request returns the same fixed ~19-row sample. Queried once
 *               rather than once per keyword, because ten keyword queries
 *               returned ten identical payloads. Yields ~1 usable posting.
 *
 *   RemoteOK  — verified and REJECTED, not wired in. Two different User-Agents
 *               both returned 100 postings with zero qualifying ML titles and
 *               zero descriptions mentioning even one core ML term (the board
 *               was returning "handyman woman" and "Meat and Seafood Clerk").
 *               Its documented ?tag= filter 302-redirects to / , which is what
 *               makes fetch fail with "redirect count exceeded". Adding it would
 *               have contributed nothing but request latency.
 *
 *   Himalayas — honours offset, caps limit at 20 regardless of what you ask for,
 *               and reports a ~95k-row board. Ships full descriptions and a real
 *               seniority field, which is where the junior/entry-level rows come
 *               from.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const OUT = 'src/data/jobs.json'
const TARGET = 120
const ARBEITNOW_PAGES = 10
const HIMALAYAS_PAGE = 20
const HIMALAYAS_MAX_OFFSET = 8000
const EVIDENCE_WIDTH = 140
const INLINE_LOOKAHEAD = 110
const SECTION_MAX_DISTANCE = 3000

const UA = {
  accept: 'application/json',
  'user-agent': 'tailor-job-fetcher',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A posting qualifies only if its TITLE matches one of these. */
const TITLE_MATCH = [
  'machine learning', 'ml engineer', 'ml scientist', 'deep learning',
  'computer vision', 'ai engineer', 'ai scientist', 'artificial intelligence',
  'data scientist', 'mlops', 'nlp', 'llm', 'genai', 'gen ai',
  'research engineer', 'research scientist', 'applied scientist',
  'perception engineer', 'ai research', 'ml infrastructure', 'ai/ml',
  'machine vision', 'image processing', 'ml platform', 'ai platform',
]

/**
 * Rejected outright. These are front-end / full-stack / non-engineering roles
 * that often mention AI in passing; the board is meant to stay clear of them.
 */
const TITLE_REJECT = [
  'full stack', 'full-stack', 'fullstack', 'front end', 'front-end', 'frontend',
  'web developer', 'ui engineer', 'ux', 'designer', 'react developer',
  'flutter', 'android', 'ios developer', 'mobile developer',
  'product manager', 'product owner', 'project manager', 'account executive',
  'sales', 'marketing', 'recruiter', 'customer success', 'consultant',
  'business development', 'chief product officer', 'seo', 'copywriter',
  'solutions architect', 'support engineer', 'working student',
]

/**
 * Controlled tech vocabulary — canonical name plus the surface forms that mean
 * the same thing.
 *
 *   aliases        matched in job text AND accepted from profile fact tokens.
 *   profileAliases accepted from a profile token only. These are forms that are
 *                  unambiguous on a resume but too ambiguous in posting prose to
 *                  tag a job with.
 *
 * The alias lists are DERIVED FROM THE CORPUS, not from memory: every form was
 * measured across the 175 fetched postings, and the count is noted where it
 * motivated the entry. This is what closes the synonym gap — the market writes
 * "TTS"/"STT"/"ASR" while the profile writes "text to speech", and without a
 * shared table get_fit_gaps reports a skill the candidate demonstrably has as
 * missing. A false negative is as damaging as a false positive here.
 *
 * Deliberately NOT aliased, with the measurement that ruled them out:
 *   'cv'        → computer vision. 10 corpus hits, roughly half of them résumé
 *                 ("apply with your CV in English", "CV writing and content").
 *   'serving'   → model deployment. 37 hits, dominated by "Serving 50,000+
 *                 customers" and "serving hundreds of millions of people".
 *   'grounding' → rag. 18 hits, ~30% ordinary English ("grounding AI risk
 *                 management in rigorous analysis"). Kept as a profileAlias.
 *   'embeddings'→ vector database. 13 hits, but it is a distinct concept and
 *                 folding it in would overstate vector-store experience.
 */
const TECH = {
  python: { aliases: ['python'] },
  sql: { aliases: ['sql'] },
  pytorch: { aliases: ['pytorch', 'torch', 'lightning', 'pytorch lightning'] },
  tensorflow: { aliases: ['tensorflow', 'tf2'] },
  keras: { aliases: ['keras'] },
  jax: { aliases: ['jax'] },
  yolo: {
    aliases: ['yolo', 'ultralytics', 'yolov5', 'yolov8', 'mmdetection', 'detectron'],
    profileAliases: ['yolo26'],
  },
  opencv: { aliases: ['opencv', 'cv2', 'open cv'] },
  'computer vision': {
    // 'cv' excluded on purpose — see header note.
    aliases: [
      'computer vision', 'image processing', 'object detection',
      'image segmentation', 'machine vision', 'visual perception',
      'vision models', 'detection models', 'video analytics',
    ],
  },
  'image classification': {
    aliases: ['image classification', 'classification model', 'cnn', 'convolutional', 'transfer learning'],
    // 'classification' is profile-only. Measured across the corpus its 16 hits
    // are ~80% natural-language work — "Text Classification, RAG, LLMs",
    // "content classification", "text classification, entity recognition,
    // sentiment analysis". As a job-text matcher it would label NLP roles as
    // image classification and then credit this candidate's vision work
    // against them. On a resume the same word is unambiguous.
    profileAliases: ['resnet', 'resnet18', 'classification'],
  },
  ocr: {
    aliases: [
      'ocr', 'optical character recognition', 'document ai', 'text extraction',
      'tesseract', 'document understanding', 'document processing',
    ],
    profileAliases: ['easyocr', 'paddleocr'],
  },
  llm: {
    aliases: [
      'llm', 'llms', 'large language model', 'large language models',
      'foundation model', 'gpt', 'vlm', 'slm',
    ],
    profileAliases: ['local llm'],
  },
  rag: {
    aliases: [
      'rag', 'retrieval augmented', 'retrieval-augmented',
      'retrieval augmented generation', 'retrieval-augmented generation',
      'semantic search',
    ],
    profileAliases: ['grounding'],
  },
  'vector database': {
    aliases: [
      'vector database', 'vector store', 'pinecone', 'weaviate', 'qdrant',
      'faiss', 'milvus', 'pgvector',
    ],
    profileAliases: ['chromadb'],
  },
  nlp: { aliases: ['nlp', 'natural language processing'] },
  speech: {
    // The synonym gap that motivated this whole layer. Corpus counts:
    // tts 2, stt 1, asr 1, speech 5, text-to-speech 1, speech-to-text 1,
    // voice ai 1, audio processing 1 — while the profile's spelled-out
    // "text to speech" / "speech recognition" score 0.
    aliases: [
      'speech', 'speech recognition', 'speech synthesis',
      'text to speech', 'text-to-speech', 'speech to text', 'speech-to-text',
      'tts', 'stt', 'asr', 'whisper', 'voice ai', 'audio processing',
    ],
    profileAliases: ['voice interface', 'voice assistant'],
  },
  docker: { aliases: ['docker', 'containerization'] },
  kubernetes: { aliases: ['kubernetes', 'k8s'] },
  aws: { aliases: ['aws', 'amazon web services', 'sagemaker'] },
  gcp: { aliases: ['gcp', 'google cloud', 'vertex ai', 'bigquery'] },
  azure: { aliases: ['azure'] },
  fastapi: { aliases: ['fastapi', 'fast api'] },
  flask: { aliases: ['flask'] },
  linux: { aliases: ['linux'] },
  git: { aliases: ['git', 'github', 'gitlab', 'version control'] },
  spark: { aliases: ['spark', 'pyspark'] },
  airflow: { aliases: ['airflow'] },
  mlflow: { aliases: ['mlflow'] },
  kubeflow: { aliases: ['kubeflow'] },
  postgresql: { aliases: ['postgres', 'postgresql'] },
  numpy: { aliases: ['numpy'] },
  pandas: { aliases: ['pandas'] },
  'real-time inference': {
    // 'latency' (42 hits, essentially all genuine performance work) and
    // 'real-time' (42 hits) added on review. Caveat on 'real-time': roughly
    // half its hits are real-time DATA rather than real-time inference
    // ("real-time data processing", "real-time behavioral data"), so this
    // concept now reads a little broader than strict inference latency.
    aliases: [
      'real-time inference', 'real time inference', 'low latency', 'low-latency',
      'latency', 'real-time', 'real time',
      'edge deployment', 'edge device', 'edge inference',
      'onnx', 'tensorrt', 'openvino', 'quantization',
    ],
  },
  'model deployment': {
    // 'serving' alone excluded — see header note.
    aliases: [
      'model deployment', 'model serving', 'production model',
      'deploy models', 'productionize', 'model registry',
    ],
  },
  react: { aliases: ['react'] },
  typescript: { aliases: ['typescript'] },

  // ---- reviewed and approved from the corpus mining pass ----
  'fine-tuning': { aliases: ['fine-tuning', 'fine tuning', 'finetuning', 'fine-tune', 'finetune', 'peft', 'lora', 'sft'] },
  langchain: { aliases: ['langchain'] },
  langgraph: { aliases: ['langgraph'] },
  llamaindex: { aliases: ['llamaindex', 'llama index', 'llama-index'] },
  'hugging face': { aliases: ['hugging face', 'huggingface'] },
  cuda: { aliases: ['cuda', 'cudnn'] },
  gpu: {
    // 'gpus' needs its own entry: the trailing boundary blocks the plural.
    aliases: ['gpu', 'gpus', 'gpu-accelerated'],
    profileAliases: ['nvidia', 'rtx 3060'],
  },
  triton: { aliases: ['triton'] },
  ray: { aliases: ['ray'] }, // hyphen-guarded below so "X-ray" cannot match
  rlhf: { aliases: ['rlhf', 'reward modeling', 'preference data', 'dpo'] },
  rl: { aliases: ['rl', 'reinforcement learning'] },
  'ci/cd': { aliases: ['ci/cd', 'cicd', 'continuous integration', 'continuous deployment'] },
  terraform: { aliases: ['terraform'] },
  kafka: { aliases: ['kafka'] },
  snowflake: { aliases: ['snowflake'] },
  etl: { aliases: ['etl', 'elt'] },
  'c++': { aliases: ['c++'] },
  java: { aliases: ['java', 'jvm'] },
  mcp: { aliases: ['mcp', 'model context protocol'] },
  bedrock: { aliases: ['bedrock'] },
  gemini: { aliases: ['gemini'] },
  flink: { aliases: ['flink'] },
  tableau: { aliases: ['tableau'] },

  // ---- second review round ----
  'prompt engineering': { aliases: ['prompt engineering', 'prompt design', 'prompt versioning'] },
  databricks: { aliases: ['databricks'] },
  'power bi': { aliases: ['power bi', 'powerbi'] },
  chatbot: { aliases: ['chatbot', 'chat bot', 'conversational ai'] },
  mysql: { aliases: ['mysql'] },
  'on-premise': {
    // The candidate's air-gapped/offline deployment experience. Job-text
    // matching uses only the unambiguous forms: 'offline' is profile-only
    // because all 18 of its corpus hits mean offline EVALUATION or offline RL
    // ("offline and online evaluation", "offline RL, actor-critic methods",
    // "offline experiments"), never on-premise hosting.
    aliases: ['on-prem', 'on-premise', 'on premise', 'self-hosted', 'self hosted', 'air-gapped', 'air gapped'],
    profileAliases: ['offline', 'closed network', 'local server'],
  },
}

/**
 * Terms that must not match when preceded by a hyphen. "ray" is the live case:
 * the default boundary treats "-" as a separator, so "X-ray" would otherwise be
 * tagged as the Ray framework — and this candidate's whole portfolio is X-ray
 * inspection work, so the collision would have fired constantly.
 */
const HYPHEN_GUARDED = new Set(['ray'])

/** A posting must carry at least one of these to count as an ML role. */
const CORE_ML = [
  'pytorch', 'tensorflow', 'keras', 'jax', 'yolo', 'opencv', 'computer vision',
  'image classification', 'ocr', 'llm', 'rag', 'nlp', 'speech', 'mlflow',
  'kubeflow', 'real-time inference',
]

/**
 * Headings that open a hard-requirement block versus a wish-list block. Kept
 * deliberately narrow: a marker that fires on ordinary prose would mislabel a
 * nice-to-have as a hard requirement, and this field exists to be trusted.
 * "bonus" and "plus" are excluded as bare words because a benefits section
 * ("annual bonus") would otherwise flip a genuine requirement to optional.
 */
const REQUIRED_MARKERS = [
  'requirements', 'required qualifications', 'required skills',
  'minimum qualifications', 'basic qualifications', 'qualifications',
  'must have', 'must-have', 'must haves',
  'what you bring', "what you'll bring", 'what you will bring', 'you bring',
  'your profile', 'who you are', 'about you',
  "what you'll need", 'what you need', 'skills and experience', 'key skills',
  "what we're looking for", 'what we are looking for', 'we expect',
  'anforderungen', 'dein profil', 'ihr profil', 'das bringst du mit',
  'was du mitbringst', 'wir erwarten',
]

const OPTIONAL_MARKERS = [
  'nice to have', 'nice-to-have', 'nice to haves', 'nice-to-haves',
  'bonus points', 'preferred qualifications', 'preferred skills',
  'preferred experience', 'desirable', 'good to have', 'extra credit',
  'pluses', 'wünschenswert', 'von vorteil',
]

/** Inline qualifiers that sit AFTER the skill, e.g. "Kubernetes is a plus". */
const INLINE_OPTIONAL = [
  'is a plus', 'are a plus', 'would be a plus', 'is a big plus',
  'is a strong plus', 'is a bonus', 'nice to have', 'is preferred',
  'preferred', 'desirable', 'would be great', 'bonus points', 'a plus',
]

/**
 * A marker only opens a section when it reads like a heading. Without this,
 * an inline qualifier — "Basic knowledge of Kubernetes and Docker is nice to
 * have." — registers as a section boundary and every later skill in the posting
 * inherits "optional", which mislabelled genuine requirements as wish-list
 * items. If the phrase is preceded by one of these words it is prose, not a
 * heading, and only its inline lookahead meaning applies.
 */
const HEADING_BLOCKERS = [
  'is', 'are', 'be', 'a', 'as', 'and', 'or', 'also', 'very',
  'the', 'these', 'those', 'any', 'all', 'meet', 'meets', 'would',
]

/**
 * Word-boundary matcher. \b is unreliable next to '/', '+' and '.', and plain
 * substring matching does not know that "Auftrag" is not "RAG", so we assert on
 * neighbouring alphanumerics directly.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const termCache = new Map()
function termRe(term) {
  let re = termCache.get(term)
  if (!re) {
    const lookBehind = HYPHEN_GUARDED.has(term) ? '(?<![a-z0-9-])' : '(?<![a-z0-9])'
    re = new RegExp(`${lookBehind}${escapeRe(term)}(?![a-z0-9])`, 'i')
    termCache.set(term, re)
  }
  return re
}
const hasTerm = (hay, term) => termRe(term).test(hay)

/**
 * The alias table, inverted once: every surface form -> its canonical tag.
 * Both directions of the product go through this map, which is the point —
 * a job posting saying "TTS" and a profile fact saying "text to speech" must
 * land on the same canonical tag or get_fit_gaps reports a false gap.
 */
const ALIAS_TO_CANONICAL = new Map()
for (const [canonical, spec] of Object.entries(TECH)) {
  ALIAS_TO_CANONICAL.set(canonical.toLowerCase(), canonical)
  for (const a of spec.aliases ?? []) ALIAS_TO_CANONICAL.set(a.toLowerCase(), canonical)
  for (const a of spec.profileAliases ?? []) ALIAS_TO_CANONICAL.set(a.toLowerCase(), canonical)
}

/**
 * Resolve any surface form — a profile fact token, a job tag, a user query —
 * to its canonical tag. Returns null when the term is outside the vocabulary,
 * which is a real answer: it means the app must not claim anything about it.
 */
function resolveToken(token) {
  if (!token) return null
  return ALIAS_TO_CANONICAL.get(String(token).trim().toLowerCase()) ?? null
}

const decodeEntities = (s) =>
  s.replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

/**
 * Arbeitnow ships markup that is itself HTML-escaped, so decoding entities after
 * stripping tags turns "&lt;div class=..&gt;" back into a live-looking tag and
 * leaks it into the stored description. Decode and strip twice instead, which
 * also handles the double-escaped rows.
 */
const stripHtml = (s = '') => {
  let out = decodeEntities(String(s)).replace(/<[^>]*>/g, ' ')
  out = decodeEntities(out).replace(/<[^>]*>/g, ' ')
  return out.replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()
}

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

const titleQualifies = (title = '') => {
  const t = String(title).toLowerCase()
  if (TITLE_REJECT.some((r) => t.includes(r))) return false
  return TITLE_MATCH.some((r) => hasTerm(t, r))
}

function detectSeniority(title, hint = '') {
  const t = String(title).toLowerCase()
  if (/\b(intern|internship|working student|werkstudent|praktikum)\b/.test(t)) return 'junior'
  if (/\b(junior|jr\.?|entry.level|graduate|new grad|associate)\b/.test(t)) return 'junior'
  if (/\b(principal|staff|head of|director|vp|chief|lead)\b/.test(t)) return 'lead'
  if (/\b(senior|sr\.?|experienced|expert)\b/.test(t)) return 'senior'

  // Fall back to the level the source itself reported, when it gave one.
  const h = String(hint).toLowerCase()
  if (/director|principal|executive|lead/.test(h)) return 'lead'
  if (/senior/.test(h)) return 'senior'
  if (/junior|entry|graduate/.test(h)) return 'junior'
  return 'mid'
}

function detectMinYears(text) {
  // Order matters. A range ("minimum 7-8 years") must be read before the generic
  // "N years of experience" pattern, or that pattern latches onto the range's
  // upper bound and reports a 7-year role as needing 8.
  const patterns = [
    /(\d+)\s*(?:-|–|to)\s*\d+\s*(?:\+\s*)?(?:years?|yrs?)/i,
    /(\d+)\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+|professional\s+|industry\s+|hands.on\s+|practical\s+|proven\s+)?(?:work\s+)?experience/i,
    /(?:at least|minimum(?: of)?|min\.?|more than|over)\s+(\d+)\s*(?:\+\s*)?(?:years?|yrs?)/i,
    /(\d+)\s*\+\s*(?:years?|yrs?)/i,
    /experience[^.]{0,40}?(\d+)\s*\+?\s*(?:years?|yrs?)/i,
    /(?:mindestens|mind\.?)\s+(\d+)\s*(?:jahre|jahren)/i,
    /(\d+)\s*(?:\+\s*)?(?:jahre|jahren)\s+(?:einschlägiger\s+)?(?:berufs)?erfahrung/i,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) {
      const n = parseInt(m[1], 10)
      if (n >= 0 && n <= 20) return n
    }
  }
  return null
}

/** Earliest match across a tag's needles, so evidence quotes the first mention. */
function firstMatch(hay, needles) {
  let best = null
  for (const n of needles) {
    const m = termRe(n).exec(hay)
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, len: m[0].length }
    }
  }
  return best
}

/** ~140 chars around the match, trimmed outward to whole words. */
function evidenceWindow(text, index, len) {
  const pad = Math.max(0, Math.floor((EVIDENCE_WIDTH - len) / 2))
  let start = Math.max(0, index - pad)
  let end = Math.min(text.length, index + len + pad)

  if (start > 0) {
    const sp = text.indexOf(' ', start)
    if (sp !== -1 && sp < index) start = sp + 1
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end)
    if (sp > index + len) end = sp
  }

  let out = text.slice(start, end).trim()
  if (start > 0) out = `…${out}`
  if (end < text.length) out = `${out}…`
  return out
}

/** Index every requirement / wish-list heading in a posting, once. */
function sectionMarkers(text) {
  const marks = []
  for (const [kind, list] of [['required', REQUIRED_MARKERS], ['optional', OPTIONAL_MARKERS]]) {
    for (const phrase of list) {
      const re = new RegExp(`(?<![a-z0-9])${escapeRe(phrase)}(?![a-z0-9])`, 'gi')
      let hit
      while ((hit = re.exec(text)) !== null) {
        const before = text.slice(Math.max(0, hit.index - 24), hit.index)
        const lastWord = (before.match(/([A-Za-zÄÖÜäöüß']+)[^A-Za-zÄÖÜäöüß']*$/) ?? ['', ''])[1].toLowerCase()
        if (HEADING_BLOCKERS.includes(lastWord)) continue
        marks.push({ index: hit.index, kind })
      }
    }
  }
  return marks.sort((a, b) => a.index - b.index)
}

/**
 * Best-effort: is this skill a hard requirement? An inline qualifier just after
 * the mention wins (it is the most specific signal), then the nearest preceding
 * heading. Anything we cannot place returns null rather than a guess.
 */
function classifyRequired(text, marks, index, len) {
  const after = text.slice(index + len, index + len + INLINE_LOOKAHEAD).toLowerCase()
  if (INLINE_OPTIONAL.some((p) => after.includes(p))) return false

  let nearest = null
  for (const m of marks) {
    if (m.index >= index) break
    nearest = m
  }
  if (!nearest) return null
  if (index - nearest.index > SECTION_MAX_DISTANCE) return null
  return nearest.kind === 'required'
}

/**
 * Returns [{tag, evidence, required}]. `text` keeps its original casing so the
 * quoted evidence reads like the posting; matching itself is case-insensitive.
 */
function detectTags(text) {
  const marks = sectionMarkers(text)
  const found = []
  for (const [tag, spec] of Object.entries(TECH)) {
    // Only `aliases` tag a job. `profileAliases` are resolution-only forms that
    // are too ambiguous in posting prose to attach a tag from.
    const hit = firstMatch(text, spec.aliases ?? [])
    if (!hit) continue
    found.push({
      tag,
      evidence: evidenceWindow(text, hit.index, hit.len),
      required: classifyRequired(text, marks, hit.index, hit.len),
    })
  }
  return found
}

/**
 * Both free APIs rate-limit, and a dropped request silently costs a whole page
 * or tag's worth of postings — so a 429 is retried with backoff, not skipped.
 */
async function getJson(url, label, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: UA })
      if (res.status === 429) {
        if (i === attempts) {
          console.warn(`  ${label}: still rate limited after ${attempts} tries, giving up`)
          return null
        }
        const wait = 2500 * i
        console.warn(`  ${label}: rate limited (429), retrying in ${wait}ms`)
        await sleep(wait)
        continue
      }
      if (!res.ok) {
        console.warn(`  ${label}: HTTP ${res.status}`)
        return null
      }
      return await res.json()
    } catch (err) {
      if (i === attempts) {
        console.warn(`  ${label} failed: ${err.message}`)
        return null
      }
      await sleep(1000 * i)
    }
  }
  return null
}

/**
 * Jobicy — remote-only, and the one source here that actually answers tag
 * queries. count=200 is honoured and roughly doubles the qualifying pool per tag
 * versus the default 50. These tags are the ones that measurably return new ML
 * rows; 'engineering', 'backend', 'cloud', 'saas' and friends were all measured
 * at zero unique additions, so they are not worth the request.
 */
async function fetchJobicy() {
  const tags = [
    'machine learning', 'pytorch', 'llm', 'data', 'analytics',
    'python', 'nlp', 'deep-learning', 'research',
  ]
  const out = []
  for (const tag of tags) {
    const body = await getJson(
      `https://jobicy.com/api/v2/remote-jobs?count=200&tag=${encodeURIComponent(tag)}`,
      `jobicy "${tag}"`,
    )
    for (const j of body?.jobs ?? []) {
      if (!titleQualifies(j.jobTitle)) continue
      out.push({
        raw: stripHtml(j.jobDescription || j.jobExcerpt || ''),
        title: j.jobTitle,
        company: j.companyName,
        location: j.jobGeo || 'Anywhere',
        remote: true,
        url: j.url,
        postedAt: (j.pubDate || '').slice(0, 10) || null,
        levelHint: j.jobLevel || '',
        source: 'Jobicy',
      })
    }
    await sleep(200)
  }
  return out
}

/**
 * Himalayas — remote-only. Caps limit at 20 no matter what is requested, but
 * honours offset, so volume comes from paging rather than from a bigger limit.
 */
async function fetchHimalayas() {
  const out = []
  for (let offset = 0; offset <= HIMALAYAS_MAX_OFFSET; offset += HIMALAYAS_PAGE) {
    const body = await getJson(
      `https://himalayas.app/jobs/api?limit=${HIMALAYAS_PAGE}&offset=${offset}`,
      `himalayas offset ${offset}`,
    )
    const rows = body?.jobs ?? []
    if (rows.length === 0) break
    for (const j of rows) {
      if (!titleQualifies(j.title)) continue
      out.push({
        raw: stripHtml(j.description || j.excerpt || ''),
        title: j.title,
        company: j.companyName,
        location: (j.locationRestrictions ?? []).join(', ') || 'Anywhere',
        remote: true,
        url: j.applicationLink || j.guid,
        postedAt: j.pubDate
          ? new Date(j.pubDate * 1000).toISOString().slice(0, 10)
          : null,
        levelHint: (j.seniority ?? []).join(','),
        source: 'Himalayas',
      })
    }
    // Himalayas starts 429-ing after roughly 120 rapid requests, and a lost page
    // is a lost handful of postings, so pace the crawl rather than race it.
    await sleep(420)
  }
  return out
}

/** Remotive — one request; its API ignores search/category/limit (see header). */
async function fetchRemotive() {
  const body = await getJson('https://remotive.com/api/remote-jobs', 'remotive')
  const out = []
  for (const j of body?.jobs ?? []) {
    if (!titleQualifies(j.title)) continue
    out.push({
      raw: stripHtml(j.description),
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || 'Anywhere',
      remote: true,
      url: j.url,
      postedAt: (j.publication_date || '').slice(0, 10) || null,
      levelHint: '',
      source: 'Remotive',
    })
  }
  return out
}

/** Arbeitnow — mostly EU on-site, which is what gives the board a non-remote half. */
async function fetchArbeitnow() {
  const out = []
  for (let page = 1; page <= ARBEITNOW_PAGES; page++) {
    const body = await getJson(
      `https://www.arbeitnow.com/api/job-board-api?page=${page}`,
      `arbeitnow page ${page}`,
    )
    const rows = body?.data ?? []
    if (rows.length === 0) break
    for (const j of rows) {
      if (!titleQualifies(j.title)) continue
      out.push({
        raw: stripHtml(j.description),
        title: j.title,
        company: j.company_name,
        location: j.location || 'Not specified',
        remote: Boolean(j.remote),
        url: j.url,
        postedAt: j.created_at
          ? new Date(j.created_at * 1000).toISOString().slice(0, 10)
          : null,
        levelHint: '',
        source: 'Arbeitnow',
      })
    }
    await sleep(400)
  }
  return out
}

function normalize(rows) {
  const seen = new Set()
  const jobs = []
  const dropped = { duplicate: 0, noCoreMl: 0, tooFewTags: 0 }

  for (const r of rows) {
    if (!r.title || !r.company) continue
    const key = `${r.title.toLowerCase().trim()}::${r.company.toLowerCase().trim()}`
    if (seen.has(key)) { dropped.duplicate++; continue }
    seen.add(key)

    // Tags are detected against the FULL posting text, not the truncated
    // description, which is exactly why each one has to carry its own evidence.
    const fullText = `${r.title}. ${r.raw}`
    const tags = detectTags(fullText)
    const tagNames = tags.map((t) => t.tag)
    if (!tagNames.some((t) => CORE_ML.includes(t))) { dropped.noCoreMl++; continue }
    if (tagNames.length < 3) { dropped.tooFewTags++; continue }

    jobs.push({
      id: `j_${slug(r.company)}_${slug(r.title)}`.slice(0, 70),
      title: r.title.trim(),
      company: r.company.trim(),
      location: r.location,
      remote: r.remote,
      seniority: detectSeniority(r.title, r.levelHint),
      minYears: detectMinYears(r.raw),
      tags,
      tagNames,
      description: r.raw.slice(0, 1400),
      url: r.url,
      postedAt: r.postedAt,
      source: r.source,
    })
  }

  // Remote first, then newest first.
  jobs.sort((a, b) => {
    if (a.remote !== b.remote) return a.remote ? -1 : 1
    return (b.postedAt ?? '').localeCompare(a.postedAt ?? '')
  })
  return { jobs: jobs.slice(0, TARGET), dropped }
}

async function main() {
  console.log('Fetching from Jobicy (remote only)...')
  const jobicy = await fetchJobicy()
  console.log(`  ${jobicy.length} postings with a qualifying title`)

  console.log('Fetching from Himalayas (remote only)...')
  const himalayas = await fetchHimalayas()
  console.log(`  ${himalayas.length} postings with a qualifying title`)

  console.log('Fetching from Arbeitnow...')
  const arbeitnow = await fetchArbeitnow()
  console.log(`  ${arbeitnow.length} postings with a qualifying title`)

  console.log('Fetching from Remotive (remote only)...')
  const remotive = await fetchRemotive()
  console.log(`  ${remotive.length} postings with a qualifying title`)

  const { jobs, dropped } = normalize([...jobicy, ...himalayas, ...arbeitnow, ...remotive])

  if (jobs.length === 0) {
    console.error('\nNo jobs collected. All sources failed or returned nothing.')
    process.exitCode = 1
    return
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    count: jobs.length,
    attribution:
      'Job data from the public Jobicy, Himalayas, Arbeitnow and Remotive APIs. Each posting links to its original page.',
    jobs,
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8')

  // ---- summary ----------------------------------------------------------
  const CV_MATCH = ['computer vision', 'pytorch', 'opencv', 'yolo', 'ocr']
  const GAP_MATCH = ['tensorflow', 'kubernetes', 'aws', 'gcp']
  const count = (pred) => jobs.filter(pred).length
  const tally = (fn) => {
    const m = {}
    for (const j of jobs) { const k = fn(j); m[k] = (m[k] ?? 0) + 1 }
    return m
  }
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}(${v})`).join(', ')

  const tagCounts = {}
  let req = 0, opt = 0, unknown = 0
  for (const j of jobs) {
    for (const t of j.tags) {
      tagCounts[t.tag] = (tagCounts[t.tag] ?? 0) + 1
      if (t.required === true) req++
      else if (t.required === false) opt++
      else unknown++
    }
  }
  const totalTags = req + opt + unknown
  const pct = (n) => `${((n / totalTags) * 100).toFixed(1)}%`

  console.log(`\nWrote ${jobs.length} jobs to ${OUT}`)
  console.log(`  dropped: ${dropped.duplicate} dup, ${dropped.noCoreMl} no core-ML tag, ${dropped.tooFewTags} under 3 tags`)
  console.log(`  remote:                   ${count((j) => j.remote)}`)
  console.log(`  CV / PyTorch / OCR etc.:  ${count((j) => j.tagNames.some((t) => CV_MATCH.includes(t)))}`)
  console.log(`  TF / K8s / AWS / GCP:     ${count((j) => j.tagNames.some((t) => GAP_MATCH.includes(t)))}`)
  console.log(`  stated years requirement: ${count((j) => j.minYears !== null)}`)
  console.log(`  by source:    ${fmt(tally((j) => j.source))}`)
  console.log(`  by seniority: ${fmt(tally((j) => j.seniority))}`)
  console.log(`  by minYears:  ${fmt(tally((j) => (j.minYears === null ? 'unstated' : `${j.minYears}y`)))}`)
  console.log(`  tag evidence: ${totalTags} tags, all with a quoted window`)
  console.log(`    required:     ${req} (${pct(req)})`)
  console.log(`    nice-to-have: ${opt} (${pct(opt)})`)
  console.log(`    unknown:      ${unknown} (${pct(unknown)})`)
  console.log(`  top tags:     ${fmt(tagCounts)}`)
}

// Only run when executed directly, so the analysis tooling can import the
// fetchers and the vocabulary instead of duplicating them.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}

export {
  TECH, CORE_ML, TITLE_MATCH, TITLE_REJECT, HYPHEN_GUARDED,
  ALIAS_TO_CANONICAL, resolveToken,
  stripHtml, titleQualifies, detectTags, detectSeniority, detectMinYears,
  fetchJobicy, fetchHimalayas, fetchArbeitnow, fetchRemotive,
}
