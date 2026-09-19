"""
Reset and seed realistic multi-ward demo data for the Setu demo.

Covers HSR Layout, Koramangala, and Indiranagar so all three wards
appear on the board during judging.
"""

import sqlite3
import sys
import base64
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.app import app


DEMO_REPORTS = [
    # ── HSR Layout ──────────────────────────────────────────────────────────
    {
        "category": "pothole",
        "description": "Deep pothole near the 27th Main and 14th Cross junction is forcing two-wheelers into oncoming traffic.",
        "latitude": 12.9115, "longitude": 77.6412,
        "priority_score": 92.0, "ward": "hsr_layout",
    },
    {
        "category": "waste",
        "description": "Overflowing bins beside HSR BDA Complex are spilling onto the footpath every evening.",
        "latitude": 12.9131, "longitude": 77.6387,
        "priority_score": 84.0, "ward": "hsr_layout",
    },
    {
        "category": "streetlight",
        "description": "Three streetlights are out along 24th Main near HSR Sector 2 Park, leaving the walking stretch dark after 8 pm.",
        "latitude": 12.9162, "longitude": 77.6430,
        "priority_score": 78.0, "ward": "hsr_layout",
    },
    {
        "category": "pothole",
        "description": "Road surface has broken up outside the Agara Lake entrance and collects water after light rain.",
        "latitude": 12.9275, "longitude": 77.6486,
        "priority_score": 71.0, "ward": "hsr_layout",
    },
    # ── Koramangala ─────────────────────────────────────────────────────────
    {
        "category": "waste",
        "description": "Mixed waste is being dumped beside the 5th Block service road in Koramangala instead of being collected.",
        "latitude": 12.9406, "longitude": 77.6189,
        "priority_score": 66.0, "ward": "koramangala",
    },
    {
        "category": "streetlight",
        "description": "Streetlight near Koramangala Post Office flickers all night. Residents report unsafe conditions.",
        "latitude": 12.9350, "longitude": 77.6245,
        "priority_score": 58.0, "ward": "koramangala",
    },
    {
        "category": "pothole",
        "description": "Large uneven patch near Forum Mall signal is slowing buses and creating risk for cyclists.",
        "latitude": 12.9344, "longitude": 77.6101,
        "priority_score": 49.0, "ward": "koramangala",
    },
    # ── Indiranagar ─────────────────────────────────────────────────────────
    {
        "category": "water",
        "description": "Water main leak on 100 Feet Road near the metro station has been creating a waterlogged stretch for 3 days.",
        "latitude": 12.9784, "longitude": 77.6408,
        "priority_score": 42.0, "ward": "indiranagar",
    },
    {
        "category": "streetlight",
        "description": "Pedestrian lane connecting 12th Main to HAL Old Airport Road is unlit after 9 pm.",
        "latitude": 12.9716, "longitude": 77.6412,
        "priority_score": 35.0, "ward": "indiranagar",
    },
    {
        "category": "pothole",
        "description": "Small pothole reported near Domlur flyover; road is still passable but deteriorating.",
        "latitude": 12.9609, "longitude": 77.6387,
        "priority_score": 24.0, "ward": "indiranagar",
    },
]

DELETE_MARKERS = (
    "test", "phase", "checkpoint", "integration",
    "hjkbnn", "hhhh", "hhkk",
)


def demo_photo(label: str, color: str) -> str:
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">'
        f'<rect width="640" height="360" fill="{color}"/>'
        f'<text x="32" y="190" fill="white" font-size="34" font-family="sans-serif">{label}</text>'
        f'</svg>'
    )
    encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def reset_demo_data() -> int:
    with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
        seeded_ids = [row[0] for row in connection.execute(
            "SELECT id FROM complaints WHERE is_demo_seed = 1"
        )]
        if DELETE_MARKERS:
            marker_query = " OR ".join(
                "LOWER(category) LIKE ? OR LOWER(description) LIKE ?"
                for _ in DELETE_MARKERS
            )
            marker_values = [
                v for m in DELETE_MARKERS
                for v in (f"%{m}%", f"%{m}%")
            ]
            stale_ids = [row[0] for row in connection.execute(
                f"SELECT id FROM complaints WHERE {marker_query}", marker_values
            )]
        else:
            stale_ids = []

        ids_to_delete = sorted(set(seeded_ids + stale_ids))
        if ids_to_delete:
            placeholders = ",".join("?" * len(ids_to_delete))
            connection.execute(
                f"DELETE FROM resolution_ledger WHERE complaint_id IN ({placeholders})",
                ids_to_delete,
            )
            connection.execute(
                f"DELETE FROM complaints WHERE id IN ({placeholders})",
                ids_to_delete,
            )
        return len(ids_to_delete)


def seed_demo_data() -> list[int]:
    client = app.test_client()
    created_ids = []
    for index, report in enumerate(DEMO_REPORTS):
        payload = {**report, "is_demo_seed": True}
        if index == 0:
            payload["photo_data"] = demo_photo("Citizen photo — HSR Pothole", "#007f8f")
        elif index == 1:
            payload["photo_data"] = demo_photo("Original report — HSR Waste", "#00b8a5")
        elif index == 4:
            payload["photo_data"] = demo_photo("Koramangala report", "#a76316")

        response = client.post("/api/complaints", json=payload)
        if response.status_code not in (200, 201):
            raise RuntimeError(
                f"Seeding report {index} failed: {response.get_data(as_text=True)}"
            )
        complaint_id = response.get_json()["id"]
        created_ids.append(complaint_id)
        # Override priority with pre-set demo values for reproducibility
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            connection.execute(
                "UPDATE complaints SET priority_score = ? WHERE id = ?",
                (report["priority_score"], complaint_id),
            )

    # Resolve first 3 reports with proof photos across different wards
    resolve_indices = [0, 1, 4]  # HSR pothole, HSR waste, Koramangala waste
    for idx in resolve_indices:
        complaint_id = created_ids[idx]
        ward = DEMO_REPORTS[idx]["ward"]
        # Always use direct DB write — seed script doesn't go through auth
        _direct_resolve(complaint_id, ward)

    return created_ids


def _direct_resolve(complaint_id: int, ward: str) -> None:
    """Directly inserts a resolved ledger entry — used only by seed script."""
    import hashlib, math
    from datetime import datetime, timezone

    timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    photo_data = demo_photo(f"Resolution proof — {ward}", "#39e6b0")
    photo_hash = hashlib.sha256(photo_data.encode()).hexdigest()

    with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
        prev = connection.execute(
            "SELECT hash FROM resolution_ledger WHERE complaint_id = ? ORDER BY sequence_number DESC LIMIT 1",
            (complaint_id,),
        ).fetchone()
        prev_hash = prev[0] if prev else None
        seq = connection.execute(
            "SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM resolution_ledger WHERE complaint_id = ?",
            (complaint_id,),
        ).fetchone()[0]

        payload = "|".join([str(complaint_id), "Resolved", timestamp, photo_hash, prev_hash or ""])
        entry_hash = hashlib.sha256(payload.encode()).hexdigest()

        connection.execute(
            """
            INSERT INTO resolution_ledger
              (complaint_id, sequence_number, status, timestamp, photo_hash, previous_hash, hash)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (complaint_id, seq, "Resolved", timestamp, photo_hash, prev_hash, entry_hash),
        )
        connection.execute(
            "UPDATE complaints SET status = 'Resolved', resolution_photo_data = ? WHERE id = ?",
            (photo_data, complaint_id),
        )


if __name__ == "__main__":
    deleted = reset_demo_data()
    ids = seed_demo_data()
    print(f"✓ Demo reset removed {deleted} old rows.")
    print(f"✓ Seeded {len(ids)} complaints across HSR Layout, Koramangala, Indiranagar.")
    print(f"  IDs: {ids}")
    print(f"  Resolved: {ids[0]}, {ids[1]}, {ids[4]} (with proof photos + ledger entries)")
