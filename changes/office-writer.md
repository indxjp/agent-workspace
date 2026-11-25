---
changelog: platform
section: Added
---

- A second built-in skill, `office-writer`, writes Word (`.docx`), PowerPoint (`.pptx`) and Excel
  (`.xlsx`) files from a typed JSON model: headings, paragraphs, lists and tables; slides with a
  title, bullets and a table; sheets of typed cells, dates included. Its one script runs through
  `run_skill_script`, so each write waits for approval, and it never replaces an existing file
  (ADR-0167).
