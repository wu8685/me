# Video handout contract

The CLI's `handoutKind` is authoritative:

- **Slide-driven** requires stable timestamped slides/pages. Each section is one
  real page with its time range and localized slide image.
- **Topic-driven** is required for interviews, talking heads, short video, and
  sources without stable pages. Sections follow topic boundaries and time
  ranges; do not invent PPT pages.

A handout is a study document, not a short summary. It includes source metadata,
method notes, ordered sections, complete transcript coverage, and the relevant
localized slides/frames. Every transcript segment must appear exactly once; an
invalid or omitted segment makes the handout incomplete.

Use `handoutKind`, `capabilities`, and `warnings` from the preview. Do not infer
Slide-driven from a title or from a single decorative frame. Do not replace a
two-hour transcript with ten bullet points and still call the result a handout.

Completion reporting must state:

- Slide-driven or Topic-driven;
- transcript coverage and any omitted segments;
- used, failed, or unavailable slides/frames;
- transcription provider degradation;
- all CLI warnings.

If only metadata or audio is available, describe the exact limitation. Useful
partial output is still partial and must not be reported as complete.

