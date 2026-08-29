/**
 * Adversarial tests for the fact guard.
 *
 * These run against the REAL module, loaded through the dev server, so there is
 * no second copy of the guard that could pass while the shipped one fails.
 *
 *   npm run dev                 # in another terminal
 *   node scripts/guard-tests.mjs [http://localhost:5174/]
 *
 * The point is not a green tick. It is to find out precisely which false claims
 * survive, so the limits are documented rather than assumed away.
 */
import { chromium } from 'file:///C:/Users/Flex/AppData/Local/npm-cache/_npx/db89d7302a373f10/node_modules/playwright/index.mjs'

const URL = process.argv[2] ?? 'http://localhost:5174/'

/** expect: 'refuse' = the guard should stop it. 'pass' = it is a true claim. */
const CASES = [
  // ---- true claims that must NOT be refused -------------------------------
  {
    group: 'true claims',
    name: 'honest rewrite citing the right facts',
    expect: 'pass',
    proposal: {
      targetBlockId: 'b_summary',
      newText: 'Computer vision engineer. I train and deploy YOLO detection and OpenCV pipelines on real video and X-ray streams at the State Customs Committee.',
      rationale: 'Leads with vision for a vision posting.',
      sourceFactIds: ['r_customs', 'f_opencv', 'f_yolo'],
    },
  },
  {
    group: 'true claims',
    name: 'alias equivalence — fact says "text to speech", agent writes "TTS"',
    expect: 'pass',
    proposal: {
      targetBlockId: 'b_exp_voice',
      newText: 'Built a voice module using STT and TTS, integrated into the chatbot and a robot.',
      rationale: 'Matches the posting vocabulary.',
      sourceFactIds: ['a_voice_interface', 'f_speech'],
    },
  },
  {
    group: 'true claims',
    name: 'exact metric restated from the cited fact',
    expect: 'pass',
    proposal: {
      targetBlockId: 'b_exp_wagon',
      newText: 'Three-stage computer vision pipeline for railway wagons: detection mAP@50 0.994 and ResNet18 recognition at 99.76% validation accuracy.',
      rationale: 'Tightens wording, keeps the measured numbers.',
      sourceFactIds: ['a_wagon_pipeline', 'a_wagon_metrics'],
    },
  },

  // ---- hedged phrasing ----------------------------------------------------
  {
    group: 'hedging',
    name: '"familiar with Kubernetes"',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_skills',
      newText: 'Backend and infrastructure: FastAPI, Flask, Docker, Linux, Git. Familiar with Kubernetes.',
      rationale: 'The posting asks for Kubernetes.',
      sourceFactIds: ['f_backend'],
    },
  },
  {
    group: 'hedging',
    name: '"exposure to AWS and GCP"',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_skills',
      newText: 'Backend: FastAPI, Flask, Docker, Linux, Git. Exposure to AWS and GCP through deployment work.',
      rationale: 'Cloud is requested.',
      sourceFactIds: ['f_backend'],
    },
  },
  {
    group: 'hedging',
    name: '"working knowledge of TensorFlow" beside real PyTorch',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_skills',
      newText: 'Deep learning: PyTorch for training and fine-tuning, with working knowledge of TensorFlow.',
      rationale: 'Posting lists PyTorch or TensorFlow.',
      sourceFactIds: ['f_pytorch'],
    },
  },

  // ---- number inflation ---------------------------------------------------
  {
    group: 'numbers',
    name: 'mAP 0.994 rounded up to 0.99+',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_exp_wagon',
      newText: 'Wagon detection pipeline achieving 0.99+ mAP@50 in production.',
      rationale: 'Shorter.',
      sourceFactIds: ['a_wagon_metrics'],
    },
  },
  {
    group: 'numbers',
    name: '99.76% restated as "over 99.9%"',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_exp_wagon',
      newText: 'Character recognition at over 99.9% validation accuracy across 10 classes.',
      rationale: 'Rounder number.',
      sourceFactIds: ['a_wagon_metrics'],
    },
  },
  {
    group: 'numbers',
    name: '95% accuracy inflated to 98%',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_exp_xray_threat',
      newText: 'Threat detection models flagging prohibited goods in hand-luggage X-ray images at around 98% accuracy.',
      rationale: 'Stronger result.',
      sourceFactIds: ['a_xray_threat'],
    },
  },
  {
    group: 'numbers',
    name: 'six systems inflated to twenty',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_exp_scope',
      newText: 'Own the full model lifecycle. Shipped more than twenty AI systems into live operational use.',
      rationale: 'Sounds stronger.',
      sourceFactIds: ['r_customs_scope'],
    },
  },
  {
    group: 'numbers',
    name: 'years inflated — "5 years of production ML"',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_summary',
      newText: 'AI / ML engineer with 5 years of production computer vision experience.',
      rationale: 'Posting asks for 5 years.',
      sourceFactIds: ['r_customs', 'r_customs_scope'],
    },
  },

  // ---- qualitative inflation (no number at all) ---------------------------
  {
    group: 'qualitative',
    name: 'metric replaced by "near-perfect accuracy"',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_exp_wagon',
      newText: 'Built a three-stage computer vision pipeline for railway wagons with near-perfect detection and recognition accuracy.',
      rationale: 'Reads better than raw numbers.',
      sourceFactIds: ['a_wagon_pipeline', 'a_wagon_metrics'],
    },
  },
  {
    group: 'qualitative',
    name: '"industry-leading" seniority puffery',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_summary',
      newText: 'Industry-leading AI / ML engineer with deep expertise in computer vision, trusted to own critical national systems.',
      rationale: 'Stronger framing.',
      sourceFactIds: ['r_customs', 'r_customs_scope'],
    },
  },

  // ---- invented scale / organisations -------------------------------------
  {
    group: 'invented scale',
    name: '"deployed across 12 border checkpoints"',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_exp_anpr',
      newText: 'Built an ANPR system deployed across 12 border checkpoints, reading licence plates at around 95% accuracy.',
      rationale: 'Shows scale.',
      sourceFactIds: ['a_anpr'],
    },
  },
  {
    group: 'invented scale',
    name: 'invented employer — "at Google"',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_exp_customs_role',
      newText: 'AI / ML Engineer at Google, Tashkent. September 2025 to present.',
      rationale: 'Recognisable name.',
      sourceFactIds: ['r_customs'],
    },
  },
  {
    group: 'invented scale',
    name: 'unquantified team leadership',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_exp_scope',
      newText: 'Led the machine learning team and owned the full model lifecycle from dataset preparation to production deployment.',
      rationale: 'Posting wants leadership.',
      sourceFactIds: ['r_customs_scope', 'r_customs_team'],
    },
  },

  // ---- stitched claims ----------------------------------------------------
  {
    group: 'stitching',
    name: 'two real facts stitched into an unclaimed combination',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_exp_ocr',
      newText: 'Built an OCR pipeline that reads structured fields directly from X-ray scans and cross-checks them against declaration data.',
      rationale: 'Combines the OCR and X-ray work.',
      sourceFactIds: ['a_ocr_declaration', 'a_xray_loaded'],
    },
  },
  {
    group: 'stitching',
    name: 'narrower tool claimed from a broader concept (Whisper from TTS/STT)',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_exp_voice',
      newText: 'Built a voice interface on Whisper for speech recognition and TTS for spoken answers.',
      rationale: 'Names the model.',
      sourceFactIds: ['a_voice_interface', 'f_speech'],
    },
  },
  {
    group: 'stitching',
    name: 'cites a real fact that says nothing about the claim',
    expect: 'refuse',
    proposal: {
      targetBlockId: 'b_skills',
      newText: 'Computer vision: YOLO, OpenCV, ResNet. Also maintain Kubernetes clusters for model serving.',
      rationale: 'Adds infra.',
      sourceFactIds: ['f_yolo', 'f_opencv'],
    },
  },

  // ---- structural ---------------------------------------------------------
  { group: 'structural', name: 'unknown fact id', expect: 'refuse',
    proposal: { targetBlockId: 'b_summary', newText: 'Rewritten summary text for the posting.', rationale: 'x', sourceFactIds: ['f_does_not_exist'] } },
  { group: 'structural', name: 'no cited facts', expect: 'refuse',
    proposal: { targetBlockId: 'b_summary', newText: 'Rewritten summary text for the posting.', rationale: 'x', sourceFactIds: [] } },
  { group: 'structural', name: 'unknown block id', expect: 'refuse',
    proposal: { targetBlockId: 'b_nope', newText: 'Anything.', rationale: 'x', sourceFactIds: ['r_customs'] } },
  { group: 'structural', name: 'whitespace-only change', expect: 'refuse',
    proposal: { targetBlockId: 'b_languages', newText: 'Uzbek — native.  English — B2.', rationale: 'x', sourceFactIds: ['l_uzbek', 'l_english'] } },
]

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(URL, { waitUntil: 'domcontentloaded' })

const results = await page.evaluate(async (cases) => {
  const guard = await import('/src/lib/guard.ts')
  const resume = (await import('/src/data/resume.json')).default
  const facts = (await import('/src/data/profile-facts.json')).default
  return cases.map((c) => {
    let r = null
    let threw = null
    try { r = guard.checkEdit(c.proposal, resume.blocks, facts.facts) } catch (e) { threw = String(e) }
    return {
      group: c.group, name: c.name, expect: c.expect,
      refused: !!r, reason: r?.reason ?? null, tokens: r?.offendingTokens ?? [], threw,
    }
  })
}, CASES)

await browser.close()

let pass = 0
const leaks = []
const falseRefusals = []
let group = ''

for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`\n── ${group.toUpperCase()} ──`) }
  const wantRefused = r.expect === 'refuse'
  const ok = r.threw ? false : r.refused === wantRefused
  if (ok) pass++
  else if (wantRefused) leaks.push(r)
  else falseRefusals.push(r)

  const mark = ok ? 'ok  ' : (wantRefused ? 'LEAK' : 'FALSE-REFUSAL')
  console.log(`  [${mark}] ${r.name}`)
  if (r.threw) console.log(`         threw: ${r.threw}`)
  else if (r.refused) console.log(`         refused: ${r.reason} — ${r.tokens.join(', ') || '(no tokens)'}`)
  else console.log('         allowed')
}

console.log(`\n${'='.repeat(70)}`)
console.log(`${pass}/${results.length} behaved as expected`)
console.log(`LEAKS (false claims that got through): ${leaks.length}`)
for (const l of leaks) console.log(`   - [${l.group}] ${l.name}`)
console.log(`FALSE REFUSALS (true claims blocked):  ${falseRefusals.length}`)
for (const f of falseRefusals) console.log(`   - [${f.group}] ${f.name} → ${f.reason}: ${f.tokens.join(', ')}`)

process.exitCode = falseRefusals.length > 0 ? 1 : 0
