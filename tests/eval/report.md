# Synthetic evaluation · development-current-branch

- Dataset SHA-256: `a8d9cec3ee985cf901f4369c75e45081aebb1a39fdec424ecf4ca1b7f1684565`
- Engine build SHA: `0aa1914763f0996c206f913fe72cbdd7310d480d`
- Engine: 0.1.0; policy revision 1; seed 17017; run 133 ms
- Caveat: Synthetic results are not production accuracy. Wilson bounds describe only this sampled distribution under independence assumptions; template clones violate independence.
- Duplicate-family caveat: Template-family samples are correlated; Wilson bounds use row counts and must not be interpreted as independent evidence. No row-level bootstrap is reported; a family-cluster bootstrap would be required for family-level uncertainty.

| Split | Cases | Sensitive | Benign | Ambiguous | Prompt precision | Prompt recall | Entity recall | FPR | False block | Benign prevented | Redaction residual |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Development | 120 | 60 | 35 | 25 | 95.24% (60/63) | 100.00% (60/60) | 100.00% (60/60) | 8.57% (3/35) | 0.00% (0/35) | 0.00% (0/35) | 0.00% (0/60) |
| Generated | 1000 | 800 | 200 | 0 | 97.56% (800/820) | 100.00% (800/800) | 100.00% (1000/1000) | 10.00% (20/200) | 0.00% (0/200) | 0.00% (0/200) | 0.00% (0/1000) |

No raw fixture text or matched values are included.
