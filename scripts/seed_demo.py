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
    {
        "category": "pothole",
        "description": "Dangerous deep asphalt pothole on 27th Main Road outside Sector 2 School entrance.",
        "latitude": 12.9060, "longitude": 77.6060,
        "priority_score": 92.0, "ward": "hsr_layout",
    },
    {
        "category": "water",
        "description": "Burst pipeline flooding the road near HSR East Hospital emergency entrance.",
        "latitude": 12.9060, "longitude": 77.5940,
        "priority_score": 86.0, "ward": "hsr_layout",
    },
    {
        "category": "waste",
        "description": "Garbage pile blocking pedestrian footpath near East Market entrance.",
        "latitude": 12.9000, "longitude": 77.6060,
        "priority_score": 64.0, "ward": "hsr_layout",
    },
    {
        "category": "streetlight",
        "description": "Broken streetlight array near North Bus Interchange (Resolved by BBMP ward crew).",
        "latitude": 12.9100, "longitude": 77.6060,
        "priority_score": 48.0, "ward": "hsr_layout",
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
        count = connection.execute("SELECT COUNT(*) FROM complaints").fetchone()[0]
        connection.execute("DELETE FROM resolution_ledger")
        connection.execute("DELETE FROM complaints")
        return count


def seed_demo_data() -> list[int]:
    client = app.test_client()
    created_ids = []
    for index, report in enumerate(DEMO_REPORTS):
        payload = {**report, "is_demo_seed": True}
        if index == 0:
            payload["photo_data"] = demo_photo("Pothole — School Corridor", "#007f8f")
        elif index == 1:
            payload["photo_data"] = demo_photo("Water Leak — Hospital Route", "#00b8a5")
        elif index == 2:
            payload["photo_data"] = demo_photo("Waste Dump — Market Zone", "#a76316")
        elif index == 3:
            payload["photo_data"] = demo_photo("Streetlight — Bus Terminal", "#063b42")

        response = client.post("/api/complaints", json=payload)
        if response.status_code not in (200, 201):
            raise RuntimeError(
                f"Seeding report {index} failed: {response.get_data(as_text=True)}"
            )
        complaint_id = response.get_json()["id"]
        created_ids.append(complaint_id)
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            connection.execute(
                "UPDATE complaints SET priority_score = ? WHERE id = ?",
                (report["priority_score"], complaint_id),
            )

    # Resolve 4th complaint (streetlight) with proof photo + ledger entry
    _direct_resolve(created_ids[3], "HSR Bus Terminal")

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
    print(f"[OK] Wiped {deleted} old database rows.")
    print(f"[OK] Seeded exactly 4 HSR Layout complaints: {ids}")
    print(f"[OK] Complaint #{ids[3]} resolved with proof photo + SHA-256 ledger seal.")
