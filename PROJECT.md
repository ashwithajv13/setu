# Setu

## MVP scope

Setu is an offline-first civic complaint reporting app. The demo flow is:

1. Capture a complaint with a photo, voice note, category, and location.
2. Save it offline and sync it when connectivity returns.
3. Rank complaints by priority.
4. Track SLA escalation.
5. Prove resolution history integrity with a hash-chained ledger.
6. Show the result on a public dashboard.

## Current phase

Phase 10: demo-ready report capture, offline outbox, duplicate merging, graph-based priority scoring, SLA escalation, hash-chained resolution ledger, and public dashboard.

## Tech stack

- Backend: Flask, SQLite
- Frontend: plain HTML and JavaScript
- Offline support: service worker and IndexedDB

## Live-demo contract

The frontend must call the backend health endpoint and display the returned message. A user must also be able to submit a complaint with a category and description, with optional compressed photo, voice, Groq classification, and location data. Offline submissions are queued in IndexedDB and retried when connectivity returns. Matching reports in the same category within 100 meters and 3 days merge into one complaint and increment `report_count`. Located complaints map to the seed road graph and can be scored through `/api/priority/<complaint_id>`. New complaints receive a seven-day `sla_deadline`; `POST /api/sla/check` escalates overdue `Received` complaints. Status transitions are recorded in a SHA-256 chain; resolving a complaint requires a photo and `/api/verify/<complaint_id>` checks the chain. The public board lists complaints by priority, shows SLA status, and displays verified resolution badges.

## Phase 8 checkpoint

- Online report creation, priority scoring, dashboard visibility, photo-backed resolution, and ledger verification passed live.
- IndexedDB outbox sync passed live: queued report was accepted by the API and removed from the outbox.

## Phase 9 checkpoint

- Added responsive teal/seafoam styling, connection indicators, loading states, submission feedback, and dashboard error/empty states.
- Backend logic remains unchanged.

## Phase 10 checkpoint

- Added `scripts/seed_demo.py` for repeatable, non-destructive demo data.
- Added `DEMO_CHECKLIST.md` for the live walkthrough, backup plan, and rehearsal flow.
- Demo complaints use `is_demo_seed = 1`; rerun `python scripts/seed_demo.py` to reset and recreate the judging dataset.
