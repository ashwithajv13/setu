# Setu Decisions

- Keep the Phase 1 scaffold intentionally small: Flask, SQLite, plain HTML/JavaScript, and a service worker.
- Defer authentication and styling until the core offline-first demo flow is working.
- Use a `models` package as the home for persistence/domain code added in later phases.
- Merge nearby reports by category, 100-meter radius, and three-day window instead of creating duplicate rows.
- Use a small deterministic NetworkX seed graph for the demo; priority combines route connectivity, nearby school/hospital proximity, and report frequency.
- Use a manual `POST /api/sla/check` trigger for the demo instead of adding a background scheduler dependency.
- Store resolution history as a per-complaint SHA-256 chain; a resolution transition requires photo data.
