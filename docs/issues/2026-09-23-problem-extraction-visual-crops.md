# Problem extraction rejected after visual crop failures

## Purpose and scope

This is an investigation handoff for the September 23, 2026 server-side Luna run on **Unit 2 Assignment 2**. It records what happened, what is visible in the source PDF, and which behaviors need a design decision. It does not prescribe or implement a fix.

The failure involves three separate concerns: locating a figure in a scanned PDF, deciding whether a question actually needs an attached visual, and deciding whether incomplete visuals should invalidate an entire extraction. A change in one area may leave the other two problems in place.

## Run and source evidence

| Item | Value |
| --- | --- |
| Run ID | `36c1a243-6ef9-41f8-ac68-ab182d52c3f9` |
| Feature | `problemExtraction` |
| Execution target | Server (`local` on `latitude7370`) |
| Model | `gpt-6-luna`, `xhigh` reasoning |
| Started / ended | `2026-09-23T22:14:13.772Z` / `2026-09-23T22:21:45.553Z` |
| Status | `failed` |
| Canvas source file ID | `2110126` |
| Source file | `25-26 Unit 2 Circular motion packet.pdf`, seven scanned letter-size pages |
| Server PDF cache at investigation time | `~/projects/School-Dashboard/.school-dashboard/cache/9fa2b7553e62a291f43b.pdf` |
| Server run store | `~/projects/School-Dashboard/.school-dashboard/runs.json` |
| Server activity log | `~/projects/School-Dashboard/.school-dashboard/activity.json` |
| Server Codex transcript | `~/.codex/sessions/2026/09/23/rollout-2026-09-23T18-14-15-01a0d055-6fb4-79f0-80e8-5ed74ac9d103.jsonl` |

The run's class directions said to ignore AP Classroom assignments and extract non-AP Classroom assignments. Page 5 of the packet is an AP Physics banked-curve sheet; the response concentrated on the other assigned sections and the review pages.

The server record's exact error is:

> Problems 24, 39, 41, Review 1, Review 2, Review 3, Review 4 require a source visual, but no crop or structured table was returned.

The Codex turn itself completed and produced valid structured JSON with 18 problems, one attached visual (problem 23), and two `unresolved` entries (the problem 19 diagram and Review 1's Figure P6.20). The dashboard rejected that JSON during its own post-turn policy check. The run store therefore has `output: null`, `rawStructuredOutput: null`, and no retained run events, although the final response is still visible in the server Codex transcript. The transcript may have its own retention policy and should not be treated as the durable run result.

## What the tools did

The activity log and transcript agree on this sequence (times UTC):

| Time | Action and result |
| --- | --- |
| 22:14:30 | Downloaded Canvas file `2110126` successfully. |
| 22:14:36 | Indexed the PDF successfully. |
| 22:14:41 | Generated a contact sheet. |
| 22:15:17–22:15:58 | Ran problem detection for the assigned sections. |
| 22:16:20 | Rendered PDF pages 1, 2, 3, 4, 6, and 7 at 200 DPI. |
| 22:18:11 | Requested three semantic crops: page 2 `65.0°` as a diagram, page 4 `165 m` as a diagram, and page 6 `Figure P6.20` as a figure. Only the page 4 crop completed. The page 2 and page 6 queries returned `not_found`. |
| 22:19:18 | Used `crop_image_regions` on the page 2 200-DPI render with `{left: 880, top: 1110, width: 430, height: 350}`. The tool returned a file path, but that rectangle does not contain problem 19's diagram. |
| 22:21:44–22:21:45 | Luna prepared its structured response; final visual validation threw the error above. |

No Canvas download, MCP connection, PDF render, or model completion failure occurred in this run.

## Direct inspection of the PDF

The PDF is a low-contrast scan. `pdftotext` yielded essentially no text on page 2, so semantic cropping had to use OCR to create text anchors. The relevant pages were rendered and visually inspected during this investigation.

| Page / problem | What is in the scan | What Luna returned or attempted |
| --- | --- | --- |
| Page 2, problem 19 | A small swing-ride diagram directly below the problem, labeled `65.0°` and `12.0 m`. The angle and cable geometry are part of the question. | Semantic crop queried `65.0°` and returned `not_found`. Luna's coordinate fallback cropped a lower region containing problem 20 text and handwritten answers, not the swing diagram. Final problem 19 had `visual: null` and was listed as unresolved. |
| Page 3, problems 39 and 41 | The prompts refer to textbook Figure 5.21, but that figure is not reproduced on this page or elsewhere in this seven-page packet. | Both had `visual: null`. The validator marked both as missing a required source visual because their text contains a figure reference. |
| Page 3, problem 40 | The skier's arc diagram is visibly present below the prompt. | Final problem 40 had `visual: null`; the current text heuristic did not flag it. |
| Page 4, problem 23 | The banked-race-track diagram is present. | Semantic crop with `165 m` succeeded; Luna attached the returned diagram path. |
| Page 4, problem 24 | The prompt refers to textbook Figures 5.10 and 5.11. Neither figure is reproduced in the packet. | Final problem 24 had `visual: null`; the validator flagged it. |
| Page 6, Review 1 | A roller-coaster figure labeled **Figure P6.20** is directly below the question. It supplies `10.0 m` and `15.0 m` radii. | Semantic crop queried `Figure P6.20` and returned `not_found`. No coordinate fallback followed. Final Review 1 had `visual: null` and was listed as unresolved. |
| Page 6, Review 2 | The model-airplane force/geometry figure labeled **Figure P6.43** is present alongside the question. | No crop was requested; final `visual: null`. |
| Page 7, Review 3 | The spinning-cylinder figure labeled **Figure P6.49** is present. | No crop was requested; final `visual: null`. |
| Page 7, Review 4 | The wedge diagram labeled **Figure P6.44** is present. | No crop was requested; final `visual: null`. |

OCR was reproduced locally with the same `tesseract.js` package and English language data used by `WorkspaceManager`, on pages rendered at its 170-DPI OCR resolution. Page 2 OCR did **not** yield the `65.0°` angle label. Page 6 OCR read the caption as **`FIGURE P8.20`**, even though visual inspection shows **`FIGURE P6.20`**. The prompt's text did include `(Fig. P6.20)`, but the semantic crop algorithm deliberately requires an exact matching *caption* when the query contains a figure identifier. A prompt mention is not accepted as the caption anchor. This explains the page 6 `not_found` result. The lack of an OCR angle anchor explains the page 2 result.

The page 2 manual fallback rectangle was checked against a fresh 200-DPI render: it captured the end of problem 20 and handwritten answer lines beginning `11) 426 N`, not the problem 19 swing diagram. The image crop tool succeeded mechanically, but the chosen coordinates were wrong. That is a separate failure from semantic OCR matching.

## Why the entire extraction failed

The relevant flow is in [`server/agent-runner.ts`](../../server/agent-runner.ts):

1. `AgentRunner` receives and parses the model's structured JSON.
2. For `problemExtraction`, it calls `enforceProblemVisualPolicy` before saving any completed output or preserving visual assets.
3. `problemRequiresVisual(markdown)` uses regular expressions that match figure references such as `Figure 5.21` and `Fig. P6.20`.
4. If a matched problem has neither `visual` nor `table`, the policy throws one error listing all such problem numbers.
5. The general catch handler marks the run `failed`. The response JSON is not retained in the run store, and this failed run cannot serve as the source for an answer-key run, which requires a completed extraction for the same assignment.

A `semantic_crop_pdf` result of `not_found` is **not itself fatal**. Luna can continue and report an unresolved item. The fatal condition is the final policy check on the returned problem Markdown and visual/table fields. In this run, that check rejected seven problems. Notably, problem 19's missing diagram did **not** appear in the rejection error despite its actual visual dependency; the regex does not catch its plain `as shown` wording. Problem 40's drawing was missed similarly. Conversely, the rule flags problems 24, 39, and 41 merely because they cite textbook figures absent from this particular PDF. These observations show that the current heuristic both misses some supplied diagrams and demands crops for some unavailable references.

Relevant code entry points:

- [`server/workspace.ts`](../../server/workspace.ts): `semanticCropPdfRegions`, OCR fallback, `visualAnchor`, and `visualRectAtAnchor`.
- [`server/tool-sessions.ts`](../../server/tool-sessions.ts): assignment-scoped `semantic_crop_pdf` and `crop_image_regions` tool handling and responses.
- [`server/agent-runner.ts`](../../server/agent-runner.ts): `problemRequiresVisual`, `enforceProblemVisualPolicy`, final run persistence, and answer-key eligibility.
- [`server/settings.ts`](../../server/settings.ts): the problem-extraction prompt instructing Luna to crop only required non-text visuals and to attach successful semantic crops directly.

## Questions for the next agent

These are decisions to investigate, not assumed fixes:

1. How should the system identify a required visual in a scanned assignment when the OCR of an otherwise clear caption or small label is wrong? Evaluate the exact-caption restriction, candidate selection, confidence checks, and any coordinate fallback. A crop returning a path is not proof that it contains the requested figure.
2. How should the system distinguish a figure actually supplied in the assignment packet from a passing reference to a textbook figure that is not supplied? In particular, should the question remain extractable with an explicit unresolved/missing-source state?
3. What should happen to an otherwise useful extraction when a subset of visuals remains unresolved? Consider what must be shown to the student and whether any downstream answer-key workflow can safely consume a partial result.
4. How should the final validation catch true visual dependencies such as problem 19 and problem 40 without treating every figure number as an available required crop?
5. How should failed post-turn validation preserve enough safe diagnostics or draft output for investigation without exposing credentials, tool tokens, or unreviewed assets?

## Reproduction and verification pointers

- The source PDF was in the server cache path above at investigation time. Cache entries and Codex transcripts may expire; Canvas file ID `2110126` is the more durable source identifier. Keep Canvas access behind `CanvasClient` / `CanvasToolSessions` as required by `AGENTS.md`.
- `pdftoppm -f 2 -l 2 -r 170 -png` and the equivalent page 6 render reproduce the images used by OCR. The app's OCR uses `tesseract.js` with `@tesseract.js-data/eng`, `rotateAuto: false`, at 170 DPI.
- A focused crop test should verify **image content**, not only `status: completed` or file existence. The page 2 wrong-coordinate crop demonstrates why.
- Regression cases should cover a missing OCR angle label (problem 19), a misread figure caption (Review 1), figures present but not requested (Review 2–4 and problem 40), textbook figure references absent from the packet (problems 24, 39, 41), and a successful semantic crop (problem 23).
- This handoff did not modify code or rerun Luna. The locally copied PDF was inspected read-only; generated page images were removed after inspection.

## Resolution

Implemented after this handoff:

1. **Missing visuals no longer fail the run.** `enforceProblemVisualPolicy` records a per-problem `missingVisual` (`not_in_source` for a figure the files do not reproduce, `not_located` for one that could not be cropped) instead of throwing. Luna sets it herself; the server fills in `not_located` when a problem needs a visual and nothing explains the gap. The answer-bank check still fails a run.
2. **Answer keys get the whole sheet.** Each completed extraction saves full source-page JPEGs (`server/source-pages.ts`: every page of a file up to 20 pages, otherwise cited pages and their neighbors). The answer-key workspace receives them as `sourceDocuments` plus per-problem `sourcePages`, alongside `missingVisual`.
3. **Crops find more figures.** Captions misread by one OCR-confusable character (`P8.20` for `P6.20`) match when unambiguous; a wrapped mention such as `Figure P6.43.` no longer competes with the printed caption; `12.0 m` and `65.0°` are treated as labels rather than problems 12 and 65; `problemNumber` lets `semantic_crop_pdf` fall back to the drawing inside that problem's region. Results report `anchor` and `note` so Luna knows when to double-check.
4. **Prompt and tools.** Luna batches all required crops, sets `problemNumber`, inspects every crop before attaching it, and may use one coordinate crop for any required visual.
5. **Visual dependencies.** `problemRequiresVisual` now recognizes "as the drawing shows", "in the drawing", and bare "as shown". `detect_pdf_problems` reports `figures` (drawings inside a detected problem's region) and `figureCaptions` (printed captions only), and detects starred problem numbers such as `*19.`.
6. **Diagnostics.** A run rejected after the Codex turn keeps its redacted structured output and events; `output` stays null, so it can never feed an answer key.

The UI shows the missing-visual warning on the problem and a **View page** button that opens a draggable, resizable, zoomable page window beside it (a bottom sheet on phones).

Verified locally against the September 23 packet (not committed): `Figure P6.20`, `P6.43`, `P6.49`, `P6.44` and problem 40's drawing crop correctly; problem 19 crops through its problem number; detection flags problems 16, 19, 23 and 40 and lists only the printed captions, so `Figure 5.21` shows as not supplied.
