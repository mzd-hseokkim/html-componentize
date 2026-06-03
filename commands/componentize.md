---
description: Convert HTML+CSS into React/Vue components (deterministic, fidelity-verified)
argument-hint: "[html-path] [react|vue]"
---

Run the **html-componentize** skill to convert static HTML+CSS into framework
components, following its full pipeline (detect → interview gaps → parse →
classify boundaries → extract data → codegen → verify fidelity).

Invoke it now via the Skill tool: `html-componentize:html-componentize`.

User-provided arguments (may be empty): `$ARGUMENTS`
- If a path to an HTML file is given, use it as the conversion source.
- If `react` or `vue` is given, use it as the target framework (otherwise rely
  on project auto-detection from `detect-project.mjs`).
- If no HTML path is given, ask the user which HTML file to convert.

Honor every GATE in the skill — especially: never inline computed styles, copy
text/data verbatim, reuse indexed components instead of regenerating, and do not
declare success until the phase-5 fidelity check passes. Point the user to
`.componentize/verify/report.html` at the end.
