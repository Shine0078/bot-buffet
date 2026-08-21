# Accessibility

The UI provides a skip link, semantic landmarks, labels, keyboard-focus outlines, status text in addition to color, live regions for desks/events, a table alternative, responsive layout, `prefers-reduced-motion` support, and Enter/Space activation for generated agent desks. The static `tests/ui.test.ts` contract guards these landmarks and keyboard semantics. Before release, run automated axe checks and keyboard/screen-reader flows at mobile and desktop breakpoints.
