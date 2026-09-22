# Semantic crop regressions

These seven 170-DPI grayscale page renders and text/OCR layouts come from the local cached
PDFs used by the actual problem-extraction runs below. They allow offline regression tests
without Canvas, Codex, Poppler, or Tesseract. No credentials, student names, or complete run
logs are included. OCR fixtures use the original render coordinates (auto-rotation disabled).

## Evidence inspected

The September 14, 2026 run `8ef23511-28f5-42f4-83ca-87dbf7f788dc` (Unit 2 Assignment 1)
used Codex session `01a09fbb-77ad-7c11-b777-ef1ffe3b7219`. Its `semantic_crop_pdf` call at
11:46:54 UTC submitted 13 regions from `2110077-25-26-Unit-2-Packet-1.pdf`, pages 5–9.
The response reported nine completed crops and four misses. The subsequent
`crop_image_regions` call at 11:47:42 supplied four manual rectangles for missed regions.
The saved structured output and persisted visual PNGs were compared with the source pages.

Rectangles below are original returned `(left, top, width, height)` pixels, not estimates:

| Page / query | Original rectangle | Observed failure |
| --- | --- | --- |
| 5 / `F1 F2 65.0° 5.00 kg` | `(661,348,669,728)` | OCR text bounds start below the force arrow and include subsequent problems. |
| 5 / `60.0 N` | `(697,1110,614,321)` | Crop starts within the force drawing and extends below it. |
| 6 / `Figure P4.19` | `(132,657,505,437)` | Broad column band; kept as a working-figure regression. |
| 6 / `Figure P4.27` | `(782,715,515,203)` | Working captioned drawing retained as a regression. |
| 7 / `M=100 kg` | `(187,1310,207,436)` | Captures the mass label but cuts away ropes, support, and angle labels above it. |
| 8 / `FIGURE 4-48` | `(718,360,603,443)` | Same-row decorative drawing intrudes from the left. |
| 9 / `3. m1 = 10.0 kg` | `(149,995,379,462)` | Cuts the left ramp and hanging mass on the right; includes the next question heading below. |
| 9 / `4. m1 = 10.0 kg` | `(792,995,230,436)` | Most of the ramp, pulley and second mass lie outside the text width. |
| 9 / `5. m1 = 10.0 kg` | `(157,1421,230,436)` | A centered, wide diagram is reduced to the left-side mass values. |

The original misses were `45.0° 60.0 N`, `M=43.8 kg`, and page 9 problems 1 and 2.
OCR ambiguities must still yield `not_found` rather than a confident crop of a different
figure. In particular, the unrotated page-5 OCR does not reliably read `60.0 N`; both
unreadable force-label queries remain eligible for the existing coordinate fallback.

The September 1 run `2ca0927e-d263-4bc6-86af-512e219b854f` (Unit 2 Packet Problems),
session `01a05ead-b4be-7511-b91b-7553239eb149`, used `semantic_crop_pdf` at 20:35:26 UTC:

| Page / query | Original rectangle (padding 8) | Observed failure |
| --- | --- | --- |
| 26 / `photoelectron spectra below` | `(34,524,1411,812)` | Includes the prompt, options, and unrelated answer bank around the two spectra. |
| 27 / `mass spectrometer, resulting in the data below` | `(119,588,1326,1282)` | Almost the rest of the page instead of the graph and its axis labels. |

## Root causes and coverage

Only queries matching the numbered-figure regex used image analysis. All other kinds,
including diagrams, graphs, spectra, and visually meaningful tables, fell back to OCR/text
problem rectangles, whose widths and vertical ordering do not describe visual bounds.
The figure path itself assumed fixed page halves and one horizontal ink band, merging
unrelated drawings sharing rows. OCR auto-deskewing additionally changed the coordinate
system without transforming its boxes back onto the original render.

The replacement uses connected graphic components, nearby labels/captions, and bounded
adjacent-panel grouping. Text locates the visual but does not limit its extent. Tests assert
visually checked content inclusion and surrounding exclusion bounds, including both graph
panels, axis titles, entire ropes/ramps/masses, the next problem, and the unrelated doodle.
They also exercise actual PNG extraction through `semanticCropPdfRegions`, differently
scaled OCR coordinates, mixed successful/missing/text-only requests, and exact figure IDs.

## Model verification

The previously installed SDK 0.150.1 runtime catalog did not list GPT-6 Luna/Sol. After
upgrading to `@openai/codex-sdk` 0.156.0, its bundled `codex app-server` `model/list`
returned `model: "gpt-6-luna"` / `displayName: "GPT-6-Luna"` and
`model: "gpt-6-sol"` / `displayName: "GPT-6-Sol"` on September 22, 2026.
These agree with the official model pages:
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and
[Sol](https://developers.openai.com/api/docs/models/gpt-6-sol).
The SDK passes these IDs unchanged; no display-name-to-alias substitution is needed.
