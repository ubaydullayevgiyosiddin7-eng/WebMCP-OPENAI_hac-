# Absent terms — what this profile does not support

> **Team-only document.** This list is not part of the fact bank and must never
> be shipped to the client bundle. It used to live inside `profile-facts.json`
> under a `deliberatelyAbsent` key; it was split out so the shipped file is
> simply clean rather than needing a build-time strip.

## Why this document exists

`src/data/profile-facts.json` records what the candidate *has* done. This
document records what he has *not* — and it exists because the product's whole
claim rests on the second list being real.

Tailor's differentiator is that the agent cannot invent experience. That is only
demonstrable if there is something genuine for it to refuse. If every technology
a posting asked for happened to be somewhere in the fact bank, the fact guard
would never fire, and the demo's central beat — *"Say I know Kubernetes"* →
**rejected** — would be theatre.

So these terms are load-bearing. They are not a gap to be closed before the
demo; they are the reason the demo means anything. They also happen to be the
terms most likely to appear in real ML postings, which is why the refusal lands
naturally rather than having to be staged.

Two consequences worth stating plainly:

- **Nothing here may be added to the fact bank to improve a match.** A fact is
  added when the candidate did the work, never when a posting wants it.
- **The guard must refuse these even when refusing looks unhelpful.** An agent
  that quietly drops an unsupported claim is behaving correctly; an agent that
  softens it into "familiar with Kubernetes" is not.

## The terms

**Deep-learning frameworks other than PyTorch**
TensorFlow, Keras, JAX. The candidate trains in PyTorch. Postings routinely list
PyTorch *or* TensorFlow as interchangeable, which makes this the single most
frequent near-miss in the corpus — and the cleanest refusal to demonstrate.

**Orchestration and infrastructure-as-code**
Kubernetes, Terraform, Helm. He ships with Docker on Linux, and deploys to
on-premise servers inside a closed network. That is real deployment experience,
but it is not cluster orchestration, and the two must not be conflated.

**Public cloud**
AWS, GCP, Azure, SageMaker. His work is deliberately air-gapped — models run on
local hardware because the data cannot leave the network. The absence of cloud
experience is a direct consequence of the domain he works in, not a gap in
diligence.

**Data engineering at scale**
Spark, Kafka, Airflow, MLflow, Kubeflow. He builds training and inference
pipelines, but not distributed data platforms or managed experiment tracking.

**Frontend**
React, TypeScript, Node.js, and frontend work generally. None. Postings that
pair ML with frontend duties are a genuine mismatch, not a stretch.

**Other languages**
Java, C++, Go, Rust. Python is the working language.

**Warehousing and analytics platforms**
Snowflake, dbt, BigQuery.

**Seniority and scale claims**
"5 years experience", "10 years experience", "team lead", "managed a team".
He started in the role in September 2025 and has worked in the field for about
a year. Any posting demanding five-plus years is a real years-gap, and the app
should report it as one rather than let it be written around.

## Maintenance

When a fact is genuinely earned, move it: delete the line here and add a fact
with an honest `tokens` list. The two documents must never both claim the same
thing — if a term appears in the fact bank and here, the fact bank is wrong
until proven otherwise.
