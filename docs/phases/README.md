# Phase reports

Historical design/implementation/validation reports, one set per delivery phase. Kept for
provenance and audit trail - each report documents what was built, what was tested, and what was
deliberately deferred at that point in the project. Not required reading to use or contribute to
the project day-to-day; see the [root README](../../README.md) and [DevRunbook.md](../../DevRunbook.md)
for that.

| Phase | Report(s) | What it covers |
|---|---|---|
| 0 | [PHASE0-ANALYSIS.md](PHASE0-ANALYSIS.md) | Architecture rationale / initial analysis |
| 1 | [PHASE1-REPORT.md](PHASE1-REPORT.md), [PHASE1-VALIDATION.md](PHASE1-VALIDATION.md) | Monitoring foundation (snapshot/compare/change-event pipeline) |
| 2 | [PHASE2-IMPLEMENTATION-REPORT.md](PHASE2-IMPLEMENTATION-REPORT.md) | Real monitoring workflow (auth, competitors, monitored URLs, scans) |
| 2.1 | [PHASE2.1-HARDENING-REPORT.md](PHASE2.1-HARDENING-REPORT.md) | Reliability hardening |
| 3 | [PHASE3-IMPLEMENTATION-REPORT.md](PHASE3-IMPLEMENTATION-REPORT.md) | AI architecture / provider isolation |
| 3.1 | [PHASE3.1-VALIDATION.md](PHASE3.1-VALIDATION.md) | AI provider validation |
| 4 | [PHASE4-VALIDATION.md](PHASE4-VALIDATION.md) | Daily competitive intelligence report (generation + email) |
| 5 | [PHASE5-VALIDATION.md](PHASE5-VALIDATION.md) | Customer-ready MVP |
| 6 | [PHASE6-DATA-AUDIT.md](PHASE6-DATA-AUDIT.md), [PHASE6-VALIDATION.md](PHASE6-VALIDATION.md) | Historical intelligence / data layer (activity metrics, price history) |
| 7 | [PHASE7-DATA-AUDIT.md](PHASE7-DATA-AUDIT.md), [PHASE7-INTELLIGENCE-MODEL.md](PHASE7-INTELLIGENCE-MODEL.md), [PHASE7-PRODUCT-ASSESSMENT.md](PHASE7-PRODUCT-ASSESSMENT.md), [PHASE7-VALIDATION.md](PHASE7-VALIDATION.md) | Pattern intelligence core (activity baseline, entity lifecycle) |
| 7.1 | [PHASE7.1-VALIDATION-REPORT.md](PHASE7.1-VALIDATION-REPORT.md) | Intelligence model hardening (window-semantics fix) |
| 7.2 | [PHASE7.2-REPOSITORY-CLEANUP-REPORT.md](PHASE7.2-REPOSITORY-CLEANUP-REPORT.md) | Repository hygiene |
| 8 | [PHASE8-DESIGN.md](PHASE8-DESIGN.md), [PHASE8-VALIDATION-REPORT.md](PHASE8-VALIDATION-REPORT.md) | Competitive Context engine (cross-competitor pattern comparison) |
| 9 | [PHASE9-PRODUCT-DIRECTION-AUDIT.md](PHASE9-PRODUCT-DIRECTION-AUDIT.md) | Product direction & intelligence gap audit (analysis only, no code) |
| 10 | [PHASE10-VALIDATION-REPORT.md](PHASE10-VALIDATION-REPORT.md) | Deterministic Digest (notable changes across all tracked competitors) |
| 11 | [PHASE11-VALIDATION-REPORT.md](PHASE11-VALIDATION-REPORT.md) | Evidence-Grounded AI Interpretation (Tier 4 AI layer on the Digest) |
