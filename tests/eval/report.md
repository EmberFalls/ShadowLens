# Synthetic evaluation · development-current-branch

- Dataset SHA-256: `2f843d2bf38c3d79a6aa3e2411f3708d6fb0baf1cb0c4e5d2a3c650fd86333a5`
- Engine Git revision: `89cf18111cbc04672c6fe29d5d36c934484f2de8`
- Engine source SHA-256: `04516f88588e7e7b402ab587e3a8827aa8ab42340283c8578ee700574051adcd`
- Engine build SHA-256: `56f2f3884fca219daf334febcf202ab67a05ab360510696f5145a7a8a6aef6b0`
- Engine: 0.1.0; policy revision 1; seed 17017; run 691 ms
- Evaluation policy: one fixed synthetic owner-protected term; the term itself is omitted from the report.
- Caveat: Synthetic metrics are not production accuracy. Percentile intervals use a deterministic family-cluster bootstrap; small or homogeneous family counts can still give misleadingly narrow intervals. Scan timing measures only synchronous engine analysis in the Node runner, not browser messaging, UI overhead, or a range of hardware.
- Duplicate-family caveat: Examples within a template family may be correlated. Reported bootstrap intervals resample whole families, not rows; they describe variation across the represented synthetic families and are not evidence of real-world accuracy.

| Split | Cases | Sensitive | Benign | Ambiguous | Prompt precision | Prompt recall | Entity recall | FPR | False warning | False block | Redaction residual |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Development | 124 | 62 | 37 | 25 | 100.00% (62/62) | 100.00% (62/62) | 100.00% (62/62) | 0.00% (0/37) | 0.00% (0/37) | 0.00% (0/37) | 0.00% (0/60) |
| Generated | 1006 | 806 | 200 | 0 | 100.00% (806/806) | 100.00% (806/806) | 100.00% (1006/1006) | 0.00% (0/200) | 0.00% (0/200) | 0.00% (0/200) | 0.00% (0/1006) |

| Split | <1k p95 (ms) | 1k–10k p95 (ms) | >10k p95 (ms) |
|---|---:|---:|---:|
| Development | 3.588 | N/A | N/A |
| Generated | 0.134 | 1.42 | 1.643 |

No raw fixture text or matched values are included.

## Synthetic regression gate

Status: **PASS** (enforced for this run)

Thresholds: prompt precision ≥ 90%; prompt recall ≥ 95%; benign false-block rate ≤ 1%; redaction residual rate and unsafe releases = 0; generated-set p95 scan latency for inputs up to 10,000 characters ≤ 300 ms. This synthetic regression gate is not independent release evidence.

## Family-cluster bootstrap intervals

Deterministic percentile bootstrap; resampling unit is the template family (2,000 replicates, seed 17017). These intervals quantify only variability across the listed synthetic families.

| Split | Families | Prompt precision 95% interval | Prompt recall 95% interval | Entity precision 95% interval | Entity recall 95% interval | False block 95% interval | Redaction residual 95% interval |
|---|---:|---:|---:|---:|---:|---:|---:|
| Development | 35 | 100.00%–100.00% | 100.00%–100.00% | 100.00%–100.00% | 100.00%–100.00% | 0.00%–0.00% | 0.00%–0.00% |
| Generated | 24 | 100.00%–100.00% | 100.00%–100.00% | 97.79%–100.00% | 100.00%–100.00% | 0.00%–0.00% | 0.00%–0.00% |

False-warning 95% family-cluster intervals: Development 0.00%–0.00%; Generated 0.00%–0.00%.

- Evaluation code SHA-256: `c860b637a28fa53ea91d1c6fd5691024d843814f8b75a120e44b7306c558a1c5`
- Corpus generator SHA-256: `f9c97b9225fcedf4c646756941a2ff411fd9e21af45330a614b4cfd00e61a641`
- Split methodology: hand-authored train_dev; template-generated stress set reported separately; holdout requires independent human authoring, external sealed storage, a verified Ed25519 reviewer signature, and exact-text plus family disjointness.
- Unsealed holdout candidate pool: 54 rows across 16 template families; labels CONFIDENTIAL_MARKER, PII_EMAIL, PII_PAYMENT_CARD, PII_PHONE, SECRET_TOKEN; not scored or release evidence.
