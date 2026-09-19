# Setu — from complaint to proof

Offline-first civic complaint reporting with graph-based priority scoring and tamper-evident resolution proof.

---

## Quick start

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m backend.app
```

Open <http://127.0.0.1:5000>.

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `SETU_SECRET_KEY` | JWT signing secret | `setu-dev-secret-change-in-prod` |
| `OFFICIAL_USERNAME` | Official login username | `official` |
| `OFFICIAL_PASSWORD` | Official login password | `setu2024` |
| `GROQ_API_KEY` | Groq LLM fallback classifier | *(disabled if unset)* |

---

## API reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | — | Liveness check |
| GET | `/api/complaints` | — | List all complaints, priority-sorted. `?ward=` filters by ward |
| POST | `/api/complaints` | — | Submit a new complaint |
| GET | `/api/complaints/<id>` | — | Fetch a single complaint |
| PATCH | `/api/complaints/<id>/status` | JWT | Update status; `Resolved` requires `photo_data` |
| GET | `/api/verify/<id>` | — | Returns full SHA-256 chain with per-block validity |
| GET | `/api/priority/<id>` | — | Recalculate and return priority score |
| POST | `/api/sla/check` | — | Manual SLA escalation trigger (auto runs every 15 min) |
| GET | `/api/impact` | — | Aggregate metrics. `?demo=1` for demo data only |
| GET | `/api/wards` | — | List available ward graphs |
| GET | `/api/twin/<ward>/<node_id>` | — | Dynamic Digital Twin simulation from live data |
| GET | `/api/complaints.csv` | — | CSV export |
| POST | `/api/auth/login` | — | Returns a 12-hour JWT for official actions |

---

## Architecture

```
Citizen (PWA) ─── offline ──→ IndexedDB outbox ─→ auto-sync on reconnect
                                                        │
                                                  POST /api/complaints
                                                        │
                                          ┌─────────────▼──────────────┐
                                          │  Duplicate check (100m)     │
                                          │  Nearest-node snap          │
                                          │  NetworkX priority score    │
                                          │  (3 wards, extensible)      │
                                          └─────────────┬──────────────┘
                                                        │
                                              SQLite (setu.db)
                                                        │
                                   ┌────────────────────┴───────────────────┐
                                   │                                         │
                            Priority board                        PATCH /status (JWT)
                            GIS map overlay                               │
                            SLA countdown                    SHA-256 hash-chain ledger
                            Digital Twin                     GET /api/verify/<id>
                                                             Public /verify/<id> page
```

**Priority formula:**
`score = 0.40 × connectivity + 0.35 × landmark_proximity + 0.25 × frequency`

**Multi-ward graph:** Add a new ward by adding one entry to `_WARD_DEFINITIONS` in `models/priority.py`. Zero other changes needed.

---

## Demo preparation

```powershell
python scripts/seed_demo.py
```

Seeds 10 realistic complaints across HSR Layout, Koramangala, and Indiranagar — 3 resolved with proof photos and ledger entries.

Then follow [DEMO_CHECKLIST.md](DEMO_CHECKLIST.md).

---

## Implementation status

| Phase | Feature | Status |
|---|---|---|
| 1 | Offline-first PWA (IndexedDB outbox, service worker) | ✅ Complete |
| 2 | Voice input — Kannada, Hindi, English | ✅ Complete |
| 3 | On-device MobileNet classification + civic label mapper (≥40% threshold) | ✅ Complete |
| 4 | Duplicate detection (100 m radius, 3-day window) | ✅ Complete |
| 5 | NetworkX graph-based priority scoring (3 wards) | ✅ Complete |
| 6 | SLA tracking + auto-escalation (APScheduler, 15-min interval) | ✅ Complete |
| 7 | JWT auth for official status updates | ✅ Complete |
| 8 | SHA-256 hash-chain ledger with real per-block verification | ✅ Complete |
| 9 | Public `/verify/<id>` page for NGO/auditor use | ✅ Complete |
| 10 | Dynamic Digital Twin from live complaint data | ✅ Complete |
