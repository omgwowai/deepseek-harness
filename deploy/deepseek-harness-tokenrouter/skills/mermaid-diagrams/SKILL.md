---
name: mermaid-diagrams
description: Prefer Mermaid code blocks for structural diagrams (flowcharts, sequence, state, ER, class, gantt, mindmap); keep normal image output for screenshots, photos, plots, mockups and anything Mermaid cannot express.
whenToUse: Use when the user asks for a diagram, flowchart, architecture picture, pipeline, state machine, call sequence, data model, timeline, or any "画个图/流程图/架构图/时序图" request, and when deciding between a Mermaid block and an image.
---

# Mermaid first for structural diagrams, images for everything else

The chat renders ```` ```mermaid ```` fenced code blocks as diagrams. For a diagram whose content is
**structure** — boxes, arrows, states, lanes, relations, phases — write a Mermaid block instead of ASCII
art, box-drawing characters, a long prose description of shapes, or a hand-made image of the same chart.

This is a preference, not a ban on images. Whenever the right answer is real pixels, use normal image
output exactly as you would without this skill.

## Decide: Mermaid or image

| The reader needs… | Use |
|---|---|
| flow, pipeline, branching logic, architecture, dependency graph | Mermaid `flowchart TD` / `flowchart LR` |
| who calls whom, request/response ordering | Mermaid `sequenceDiagram` |
| lifecycle, status transitions | Mermaid `stateDiagram-v2` |
| tables, relations, schemas | Mermaid `erDiagram` |
| class / type structure | Mermaid `classDiagram` |
| schedule, phases | Mermaid `gantt` |
| hierarchy, topic breakdown | Mermaid `mindmap` |
| a screenshot of a page, app, terminal or test run; visual evidence of UI state | **image** (the screenshot itself) |
| photos, scans, generated or edited pictures, icons, illustrations | **image** |
| data plots with real axes and many points (line/scatter/histogram/heatmap) | **image** (e.g. a matplotlib PNG/SVG) |
| UI mockups, layouts, geometry, maps, floor plans, anything where position and size carry meaning | **image** or an inline SVG drawing |
| the user explicitly asks for an image/PNG/SVG/file, or the destination cannot render Mermaid | **image file** (see below) |

Rules of thumb:

- If the content would be the same drawn by any tool — nodes and edges — it is Mermaid.
- If the content *is* what something looks like, it is an image. Never replace a screenshot with a diagram of it.
- If a Mermaid version would need many workarounds (manual positioning, dozens of styled nodes, overlapping
  lanes), it is not a Mermaid diagram — draw it as an image instead.
- Showing a tool's image result (screenshot, rendered chart, generated picture) is always fine; do not
  re-describe it as Mermaid.

## Rules that keep a Mermaid block renderable

- Keep node labels short; put detail in a `note` or in the surrounding prose.
- Wrap any label containing `()`, `:`, `,`, `/`, or quotes in double quotes: `A["read(file.ts)"]`.
- Prefer `flowchart TD` for top-down narratives and `flowchart LR` for pipelines.
- Keep one diagram under ~20 nodes; split larger ones into a second diagram.
- Do not mix several diagram types in one block, and do not put Markdown inside labels.
- Never emit a diagram type you cannot write correctly — a plain `flowchart` beats a broken chart.

## When a structural diagram must also be a file

Some destinations only show the code block (a report, a slide, a PDF, a pull request, another chat app).
When the diagram has to end up as an image or inside a document:

1. still write the Mermaid block so the source is reviewable, and
2. also produce the rendered file — an SVG/PNG written to the task workspace, or embedded into the
   deliverable with the relevant document skill.

For example, render with the Mermaid CLI when it is available:

```bash
npx -y @mermaid-js/mermaid-cli -i diagram.mmd -o diagram.svg
```

Keep the `.mmd`/`.md` source next to the rendered file so the diagram stays editable.
