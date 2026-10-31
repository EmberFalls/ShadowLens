# Independent holdout workflow

The checked-in `holdout-candidates.jsonl` is visible to the detector authors and is **not** release evidence. An independent reviewer must author a new set from scratch and keep both labels and prompts outside this repository until the release engine SHA is frozen.

## Reviewer key

The reviewer generates a signing key pair in a protected directory outside the repository:

```powershell
node tests/eval/generate-reviewer-key.mjs --private-key D:\ShadowLens-Sealed\reviewer-private.pem --public-key D:\ShadowLens-Sealed\reviewer-public.pem
```

The private key stays with the reviewer. The evaluator receives the public key through a trusted path outside the checkout and verifies its fingerprint before accepting any result.

## Author and sign the corpus

The independent reviewer creates `holdout.jsonl` in a new external directory using the frozen record schema in `eval.mjs`. Every record must use `split: "holdout"` and `source: "independent_human"`. The evaluator requires at least 30 rows, 10 template families, 10 sensitive examples, 10 benign examples, and 5 ambiguous examples. Keep `templateFamily` labels consistent within a family. The scorer also rejects exact text and family overlap with development data.

Once the detector source and engine are frozen, record the release commit SHA and sign the exact JSONL bytes:

```powershell
node tests/eval/sign-holdout.mjs --directory D:\ShadowLens-Sealed --release-sha <40-character-commit-sha> --reviewer-id <independent-reviewer-id> --private-key D:\ShadowLens-Sealed\reviewer-private.pem
```

The signer validates the record schema and class/family minimums, then creates `holdout-attestation.json` with the corpus hash, reviewer key fingerprint, release SHA, timestamp, and Ed25519 signature. It refuses to overwrite an existing attestation; any corpus edit requires a new review and signature.

## Score the frozen release

The evaluator must use an external copy of the sealed directory and the reviewer's public key. The reviewer identity, detector author, evaluator, and frozen engine SHA must all be distinct/consistent as shown:

```powershell
$env:EVAL_HOLDOUT_DIR = 'D:\ShadowLens-Sealed'
$env:HOLDOUT_REVIEWER_PUBLIC_KEY_FILE = 'D:\ShadowLens-Sealed\reviewer-public.pem'
$env:HOLDOUT_REVIEWER_ID = '<independent-reviewer-id>'
$env:DETECTOR_AUTHOR_ID = '<detector-author-id>'
$env:EVALUATOR_ID = '<evaluator-id>'
$env:RELEASE_ENGINE_SHA = '<40-character-commit-sha>'
npm --prefix tests/eval run eval:holdout
```

The holdout prompts and labels are read from outside the repository and are not copied into reports. The report records aggregate metrics, corpus hash, reviewer key fingerprint, and release SHA. Do not tune against a scored holdout; a new detector revision requires a new independently authored and signed holdout.
