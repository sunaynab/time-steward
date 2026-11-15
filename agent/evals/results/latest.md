# Time Steward eval results

**Model:** anthropic/claude-haiku-5-5 · **Date:** 11/15/2026, 2:06:08 PM · **Trials:** 3

| Metric | Value |
|---|---|
| Case pass rate | **98%** (47/48 runs) |
| Check pass rate | 99% (113/114) |
| Passed every trial | 15/16 cases |
| Median latency per case | 4.7s |
| Tokens per case (avg) | 20,764 |

| Category | Pass rate |
|---|---|
| logging | 100% (21/21) |
| corrections | 100% (3/3) |
| grounding | 100% (6/6) |
| safety | 100% (9/9) |
| planning | 83% (5/6) |
| quality | 100% (3/3) |

## Failures

- **plan-quality** (trial 3)
  - ✗ no overlaps with existing events or each other: TS · Exercise × Work; TS · Exercise × Work