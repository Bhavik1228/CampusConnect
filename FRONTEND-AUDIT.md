# Frontend audit

## Scope and result

The Hallmark static audit covered `app/src` and `app/mobile` (96 files). It finished with 218 FAILs, 1,489 REFLEX findings, and 170 WARNs. The remaining FAILs are documented below as static false positives or intentional usability exceptions; they are not silently waived. The audit's browser-render pass was off.

The refactor raised the global web type scale and all remaining web CSS declarations below 14px, including print labels and tables. It also simplified nested page surfaces, replaced decorative uppercase/tracked labels with sentence-case text, improved disabled and keyboard-focus states, removed dead landing-page chrome/reveal styles, and replaced compact dot/dash copy with clearer punctuation. Exact-value color tokens preserve distinct status and chart colors rather than collapsing them into one accent.

## Remaining static FAILs

| Gate | Count | Disposition |
|---|---:|---|
| 54 | 209 | These are short context labels immediately before headings, such as a school, role, or section name. The rule treats proximity as proof of redundancy, but the labels disambiguate otherwise similar screens. They are now 14px, sentence case, and untracked; removing them would make navigation less clear. |
| 4 | 1 | The system-owner school editor is a fixed modal overlay. It is intentionally rendered inside the page's content tree, but visually sits above the page rather than forming a nested card. |
| 26a | 3 | The mobile shared button has a high-contrast focus state driven by React Native `onFocus`; the web HTML shell supplies a global `:focus-visible` rule for links and other controls. The static rule does not follow shared component behavior or CSS embedded in the web-only HTML shell. |
| 34 | 1 | The mobile web shell applies `overflow-x: clip` to both `html` and `body`, using both inline styles and its global style block. The checker does not parse these JSX style sources. |
| 56 | 1 | The workspace sidebar and top bar are sticky in separate layout columns. The public-school sticky header belongs to a different route, so the three elements do not stack or overlap. |
| 67 | 3 | The tracked strings are technical codes: an error code, a library slip code, and an MFA secret. Slight character spacing improves transcription and reduces ambiguity; ordinary labels are untracked. |

Other formerly failing items were corrected, including sub-14px typography, disabled controls that relied on opacity alone, width-based transitions, the landing-page fake browser chrome, punctuation-heavy metadata, and redundant outer card surfaces.

## Verification

- Mobile `typecheck` and all 4 mobile tests passed.
- The final web production build is currently blocked by 11 TypeScript diagnostics in the in-progress grade-entry grid changes in [GradesResultsPage.tsx](./app/src/pages/GradesResultsPage.tsx). These include unused grid state and values typed as `string | undefined`; they are outside this visual-audit change and were left untouched.
- `npx vite build` successfully bundled the final frontend; existing dynamic-import and large-chunk warnings remain.
- A local landing-page view was opened and visually inspected. The full route set was not visually rendered; authenticated school routes were not covered by that spot check.
- `git diff --check` passed. The Windows checkout reports its existing LF-to-CRLF normalization warning for `app/mobile/app/+html.tsx`.
