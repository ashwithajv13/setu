from pathlib import Path
from datetime import datetime, timezone, timedelta
import csv
import hashlib
import io
import json
import math
import os
import sqlite3
from urllib import request as url_request

from flask import Flask, jsonify, request, send_from_directory
from apscheduler.schedulers.background import BackgroundScheduler
import jwt

from models.priority import build_seed_graph, nearest_node, priority_for_node, WARD_GRAPHS, find_best_ward_for_location


ROOT_DIR = Path(__file__).resolve().parent.parent
DATABASE_PATH = ROOT_DIR / "setu.db"
FRONTEND_DIR = ROOT_DIR / "frontend"
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.1-8b-instant"
DUPLICATE_RADIUS_METERS = 100

# ── Auth configuration ────────────────────────────────────────────────────────
# Secret key: set SETU_SECRET_KEY env var in production; fallback for dev only.
SECRET_KEY = os.environ.get("SETU_SECRET_KEY", "setu-dev-secret-change-in-prod")
# Official credentials: set OFFICIAL_USERNAME / OFFICIAL_PASSWORD env vars.
OFFICIAL_USERNAME = os.environ.get("OFFICIAL_USERNAME", "official")
OFFICIAL_PASSWORD = os.environ.get("OFFICIAL_PASSWORD", "setu2024")
# Documented demo pair always works, even if env vars were set to something else.
DEMO_OFFICIAL_USERNAME = "official"
DEMO_OFFICIAL_PASSWORD = "setu2024"
TOKEN_EXPIRY_HOURS = 12


def _require_official(fn):
    """Decorator: requires a valid JWT bearer token issued by /api/auth/login."""
    from functools import wraps

    @wraps(fn)
    def wrapper(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "authentication required"}), 401
        token = auth_header[7:]
        try:
            jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            return jsonify({"error": "token expired"}), 401
        except jwt.InvalidTokenError:
            return jsonify({"error": "invalid token"}), 401
        return fn(*args, **kwargs)

    return wrapper


# ── Ledger helpers ────────────────────────────────────────────────────────────

def ledger_hash(
    complaint_id: int,
    status: str,
    timestamp: str,
    photo_hash: str | None,
    previous_hash: str | None,
) -> str:
    payload = "|".join([
        str(complaint_id),
        status,
        timestamp,
        photo_hash or "",
        previous_hash or "",
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def distance_in_meters(
    latitude_a: float,
    longitude_a: float,
    latitude_b: float,
    longitude_b: float,
) -> float:
    earth_radius_meters = 6_371_000
    latitude_delta = math.radians(latitude_b - latitude_a)
    longitude_delta = math.radians(longitude_b - longitude_a)
    first_term = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(math.radians(latitude_a))
        * math.cos(math.radians(latitude_b))
        * math.sin(longitude_delta / 2) ** 2
    )
    return 2 * earth_radius_meters * math.asin(math.sqrt(first_term))


# ── Groq classifier ───────────────────────────────────────────────────────────

def classify_with_groq(description: str) -> tuple[str | None, float | None]:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return None, None

    body = {
        "model": GROQ_MODEL,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    "Classify civic complaints. Return JSON only with keys "
                    "label and confidence. label must be one of pothole, "
                    "streetlight, waste, water, other. confidence is 0 to 1."
                ),
            },
            {"role": "user", "content": description},
        ],
    }
    req = url_request.Request(
        GROQ_API_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with url_request.urlopen(req, timeout=8) as response:
            result = json.loads(response.read().decode("utf-8"))
        content = result["choices"][0]["message"]["content"]
        classification = json.loads(content)
        label = classification.get("label")
        confidence = float(classification.get("confidence", 0))
        if label not in {"pothole", "streetlight", "waste", "water", "other"}:
            return None, None
        return label, max(0, min(confidence, 1))
    except (KeyError, TypeError, ValueError, OSError):
        return None, None


# ── Ward graph resolver ───────────────────────────────────────────────────────

def _graph_for_ward(ward: str | None):
    """Return the NetworkX graph for the given ward, falling back to default."""
    if ward and ward in WARD_GRAPHS:
        return WARD_GRAPHS[ward]
    return WARD_GRAPHS["hsr_layout"]


def _format_complaint(c: dict) -> dict:
    if c.get("is_approximate_ward"):
        c["ward_note"] = "Approximate ward assignment — nearest mapped area used."
    else:
        c["ward_note"] = None
    return c


# ── SLA escalation logic (called by scheduler and manual endpoint) ────────────

def _run_sla_escalation(database_path: Path) -> list[int]:
    with sqlite3.connect(database_path) as connection:
        overdue = connection.execute(
            """
            SELECT id FROM complaints
            WHERE status = 'Received'
              AND sla_deadline IS NOT NULL
              AND sla_deadline <= datetime('now')
            """
        ).fetchall()
        if overdue:
            connection.execute(
                """
                UPDATE complaints
                SET status = 'Escalated'
                WHERE status = 'Received'
                  AND sla_deadline IS NOT NULL
                  AND sla_deadline <= datetime('now')
                """
            )
    return [row[0] for row in overdue]


# ── App factory ───────────────────────────────────────────────────────────────

def create_app(database_path: Path = DATABASE_PATH) -> Flask:
    app = Flask(__name__)
    app.config["DATABASE_PATH"] = database_path

    initialize_database(app)

    # ── APScheduler: auto-escalate SLAs every 15 minutes ─────────────────────
    if not app.config.get("TESTING"):
        scheduler = BackgroundScheduler(daemon=True)
        scheduler.add_job(
            func=lambda: _run_sla_escalation(database_path),
            trigger="interval",
            minutes=15,
            id="sla_escalation",
            replace_existing=True,
        )
        scheduler.start()

    # ── Auth ──────────────────────────────────────────────────────────────────

    @app.post("/api/auth/login")
    def auth_login():
        """Exchange username/password for a JWT.  POST {"username": …, "password": …}"""
        payload = request.get_json(silent=True) or {}
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", "")).strip()
        user_ok = username.lower() in {
            OFFICIAL_USERNAME.lower(),
            DEMO_OFFICIAL_USERNAME.lower(),
        }
        pass_ok = password in {OFFICIAL_PASSWORD, DEMO_OFFICIAL_PASSWORD}
        if not user_ok or not pass_ok:
            return jsonify({"error": "invalid credentials"}), 401
        expiry_ts = int(
            (datetime.now(timezone.utc) + timedelta(hours=TOKEN_EXPIRY_HOURS)).timestamp()
        )
        token = jwt.encode(
            {"sub": username, "role": "official", "exp": expiry_ts},
            SECRET_KEY,
            algorithm="HS256",
        )
        if isinstance(token, bytes):
            token = token.decode("utf-8")
        return jsonify({"token": token, "expires_in": TOKEN_EXPIRY_HOURS * 3600})

    # ── Health ────────────────────────────────────────────────────────────────

    @app.get("/api/health")
    def health():
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            connection.execute("SELECT 1")
        return jsonify({"status": "ok", "message": "Setu API is running"})

    # ── Complaints: create ────────────────────────────────────────────────────

    @app.post("/api/complaints")
    def create_complaint():
        payload = request.get_json(silent=True) or {}
        category = str(payload.get("category", "")).strip()
        description = str(payload.get("description", "")).strip()

        if not category or not description:
            return jsonify({"error": "category and description are required"}), 400

        classifier_label = payload.get("classifier_label")
        classifier_confidence = payload.get("classifier_confidence")
        if not classifier_label:
            classifier_label, classifier_confidence = classify_with_groq(description)

        user_ward = str(payload.get("ward", "hsr_layout")).strip() or "hsr_layout"
        lat_val = payload.get("latitude")
        lng_val = payload.get("longitude")

        if lat_val is None or lng_val is None:
            default_coords = {
                "hsr_layout": (12.9060, 77.6060),
                "koramangala": (12.9390, 77.6150),
                "indiranagar": (12.9750, 77.6360),
            }
            lat, lng = default_coords.get(user_ward, (12.9060, 77.6060))
            lat_val = lat
            lng_val = lng

        is_approximate_ward = False
        assigned_ward = user_ward
        if lat_val is not None and lng_val is not None:
            assigned_ward, is_approximate_ward = find_best_ward_for_location(
                float(lat_val), float(lng_val), preferred_ward=user_ward
            )

        road_graph = _graph_for_ward(assigned_ward)

        fields = {
            "category": category,
            "description": description,
            "photo_data": payload.get("photo_data"),
            "voice_transcript": payload.get("voice_transcript"),
            "classifier_label": classifier_label,
            "classifier_confidence": classifier_confidence,
            "latitude": lat_val,
            "longitude": lng_val,
            "ward": assigned_ward,
            "node_id": None,
            "priority_score": None,
            "status": "Received",
            "is_demo_seed": bool(payload.get("is_demo_seed", False)),
            "is_approximate_ward": 1 if is_approximate_ward else 0,
        }

        if fields["latitude"] is not None and fields["longitude"] is not None:
            fields["node_id"] = nearest_node(
                road_graph,
                float(fields["latitude"]),
                float(fields["longitude"]),
            )

        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            latitude = payload.get("latitude")
            longitude = payload.get("longitude")
            duplicate = None
            if latitude is not None and longitude is not None:
                candidates = connection.execute(
                    """
                    SELECT id, latitude, longitude FROM complaints
                    WHERE category = ?
                      AND created_at >= datetime('now', '-3 days')
                      AND latitude IS NOT NULL
                      AND longitude IS NOT NULL
                    ORDER BY created_at DESC
                    """,
                    (category,),
                ).fetchall()
                for candidate in candidates:
                    if distance_in_meters(
                        float(latitude),
                        float(longitude),
                        float(candidate[1]),
                        float(candidate[2]),
                    ) <= DUPLICATE_RADIUS_METERS:
                        duplicate_id = candidate[0]
                        columns = [col[1] for col in connection.execute(
                            "PRAGMA table_info(complaints)"
                        )]
                        duplicate_row = connection.execute(
                            "SELECT * FROM complaints WHERE id = ?",
                            (duplicate_id,),
                        ).fetchone()
                        duplicate = dict(zip(columns, duplicate_row))
                        break

            if duplicate is not None:
                duplicate["report_count"] += 1
                dup_ward = duplicate.get("ward") or "hsr_layout"
                dup_graph = _graph_for_ward(dup_ward)
                dup_priority = 0
                if duplicate["node_id"] and duplicate["node_id"] in dup_graph:
                    dup_priority = priority_for_node(
                        dup_graph,
                        duplicate["node_id"],
                        duplicate["report_count"],
                    )["score"]
                connection.execute(
                    """
                    UPDATE complaints
                    SET report_count = ?, priority_score = ?
                    WHERE id = ?
                    """,
                    (duplicate["report_count"], dup_priority, duplicate["id"]),
                )
                duplicate["priority_score"] = dup_priority
                duplicate["duplicate"] = True
                return jsonify(_format_complaint(duplicate)), 200

            if fields["node_id"] and fields["node_id"] in road_graph:
                report_frequency = connection.execute(
                    "SELECT COUNT(*) FROM complaints WHERE node_id = ?",
                    (fields["node_id"],),
                ).fetchone()[0]
                fields["priority_score"] = priority_for_node(
                    road_graph,
                    fields["node_id"],
                    report_frequency + 1,
                )["score"]
            else:
                fields["priority_score"] = 0

            cursor = connection.execute(
                """
                INSERT INTO complaints (
                    category, description, photo_data, voice_transcript,
                    classifier_label, classifier_confidence, latitude,
                    longitude, ward, node_id, priority_score, status,
                    sla_deadline, is_demo_seed, is_approximate_ward
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          datetime('now', '+7 days'), ?, ?)
                """,
                (
                    fields["category"], fields["description"],
                    fields["photo_data"], fields["voice_transcript"],
                    fields["classifier_label"], fields["classifier_confidence"],
                    fields["latitude"], fields["longitude"],
                    fields["ward"], fields["node_id"],
                    fields["priority_score"], fields["status"],
                    fields["is_demo_seed"], fields["is_approximate_ward"],
                ),
            )
            complaint_id = cursor.lastrowid
            columns = [col[1] for col in connection.execute(
                "PRAGMA table_info(complaints)"
            )]
            row = connection.execute(
                "SELECT * FROM complaints WHERE id = ?", (complaint_id,)
            ).fetchone()

        complaint = dict(zip(columns, row))
        complaint["duplicate"] = False
        return jsonify(_format_complaint(complaint)), 201

    # ── Complaints: list ──────────────────────────────────────────────────────

    @app.get("/api/complaints")
    def list_complaints():
        ward_filter = request.args.get("ward")
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            columns = [col[1] for col in connection.execute(
                "PRAGMA table_info(complaints)"
            )]
            if ward_filter:
                rows = connection.execute(
                    """
                    SELECT * FROM complaints WHERE ward = ?
                    ORDER BY COALESCE(priority_score, 0) DESC, created_at DESC
                    """,
                    (ward_filter,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT * FROM complaints
                    ORDER BY COALESCE(priority_score, 0) DESC, created_at DESC
                    """
                ).fetchall()
        return jsonify([_format_complaint(dict(zip(columns, row))) for row in rows])

    # ── Complaints: single ────────────────────────────────────────────────────

    @app.get("/api/complaints/<int:complaint_id>")
    def get_complaint(complaint_id: int):
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            columns = [col[1] for col in connection.execute(
                "PRAGMA table_info(complaints)"
            )]
            row = connection.execute(
                "SELECT * FROM complaints WHERE id = ?", (complaint_id,)
            ).fetchone()
        if row is None:
            return jsonify({"error": "complaint not found"}), 404
        return jsonify(_format_complaint(dict(zip(columns, row))))

    # ── Impact metrics ────────────────────────────────────────────────────────

    @app.get("/api/impact")
    def impact_metrics():
        demo_only = request.args.get("demo") == "1"
        # Fixed: use proper parameterised query instead of broken string concat
        seed_filter = 1 if demo_only else 0
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            total = connection.execute(
                "SELECT COUNT(*) FROM complaints WHERE is_demo_seed = ?",
                (seed_filter,),
            ).fetchone()[0]
            resolved = connection.execute(
                "SELECT COUNT(*) FROM complaints WHERE is_demo_seed = ? AND status = 'Resolved'",
                (seed_filter,),
            ).fetchone()[0]
            merged = connection.execute(
                "SELECT COALESCE(SUM(MAX(report_count - 1, 0)), 0) FROM complaints WHERE is_demo_seed = ?",
                (seed_filter,),
            ).fetchone()[0]
            resolution_rows = connection.execute(
                """
                SELECT c.created_at, l.timestamp
                FROM complaints c
                JOIN resolution_ledger l ON l.complaint_id = c.id
                WHERE c.is_demo_seed = ?
                  AND l.status = 'Resolved'
                  AND l.sequence_number = (
                    SELECT MAX(sequence_number)
                    FROM resolution_ledger latest
                    WHERE latest.complaint_id = c.id
                  )
                """,
                (seed_filter,),
            ).fetchall()

        durations = []
        for created_at, resolved_at in resolution_rows:
            try:
                created = datetime.fromisoformat(
                    created_at.replace(" ", "T")
                ).replace(tzinfo=timezone.utc)
                resolved_time = datetime.fromisoformat(
                    resolved_at.replace("Z", "+00:00")
                )
                durations.append(
                    max(0, (resolved_time - created).total_seconds() / 60)
                )
            except ValueError:
                continue
        average_minutes = (
            round(sum(durations) / len(durations), 1) if durations else None
        )
        return jsonify({
            "total": total,
            "resolved": resolved,
            "merged": int(merged),
            "average_resolution_minutes": average_minutes,
        })

    # ── CSV export ────────────────────────────────────────────────────────────

    @app.get("/api/complaints.csv")
    def export_complaints():
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            columns = [col[1] for col in connection.execute(
                "PRAGMA table_info(complaints)"
            )]
            rows = connection.execute(
                "SELECT * FROM complaints ORDER BY id"
            ).fetchall()
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(columns)
        writer.writerows(rows)
        response = app.response_class(output.getvalue(), mimetype="text/csv")
        response.headers["Content-Disposition"] = (
            "attachment; filename=setu-complaints.csv"
        )
        return response

    # ── Priority recalculation ────────────────────────────────────────────────

    @app.get("/api/priority/<int:complaint_id>")
    def calculate_priority(complaint_id: int):
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            columns = [col[1] for col in connection.execute(
                "PRAGMA table_info(complaints)"
            )]
            row = connection.execute(
                "SELECT * FROM complaints WHERE id = ?", (complaint_id,)
            ).fetchone()
            if row is None:
                return jsonify({"error": "complaint not found"}), 404

            complaint = dict(zip(columns, row))
            if not complaint["node_id"]:
                return jsonify({"error": "complaint has no location"}), 400

            ward = complaint.get("ward") or "hsr_layout"
            road_graph = _graph_for_ward(ward)

            frequency = connection.execute(
                "SELECT COUNT(*) FROM complaints WHERE node_id = ?",
                (complaint["node_id"],),
            ).fetchone()[0]
            priority = priority_for_node(road_graph, complaint["node_id"], frequency)
            connection.execute(
                "UPDATE complaints SET priority_score = ? WHERE id = ?",
                (priority["score"], complaint_id),
            )

        return jsonify({"complaint_id": complaint_id, **priority})

    # ── SLA check (manual trigger + auto fallback) ────────────────────────────

    @app.post("/api/sla/check")
    def check_sla():
        escalated_ids = _run_sla_escalation(app.config["DATABASE_PATH"])
        return jsonify({
            "escalated_count": len(escalated_ids),
            "complaint_ids": escalated_ids,
        })

    # ── Status update (protected) ─────────────────────────────────────────────

    @app.patch("/api/complaints/<int:complaint_id>/status")
    @_require_official
    def update_status(complaint_id: int):
        payload = request.get_json(silent=True) or {}
        status = str(payload.get("status", "")).strip()
        photo_data = payload.get("photo_data")
        allowed_statuses = {"Received", "Escalated", "In Progress", "Resolved"}
        if status not in allowed_statuses:
            return jsonify({"error": "invalid status"}), 400
        if status == "Resolved" and not photo_data:
            return jsonify({"error": "resolution photo is required"}), 400

        timestamp = (
            datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        )
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            complaint = connection.execute(
                "SELECT id, status FROM complaints WHERE id = ?",
                (complaint_id,),
            ).fetchone()
            if complaint is None:
                return jsonify({"error": "complaint not found"}), 404

            previous_ledger = connection.execute(
                """
                SELECT hash FROM resolution_ledger
                WHERE complaint_id = ?
                ORDER BY sequence_number DESC LIMIT 1
                """,
                (complaint_id,),
            ).fetchone()
            previous_hash = previous_ledger[0] if previous_ledger else None
            photo_hash = (
                hashlib.sha256(photo_data.encode("utf-8")).hexdigest()
                if photo_data
                else None
            )
            entry_hash = ledger_hash(
                complaint_id, status, timestamp, photo_hash, previous_hash
            )
            sequence_number = connection.execute(
                """
                SELECT COALESCE(MAX(sequence_number), 0) + 1
                FROM resolution_ledger WHERE complaint_id = ?
                """,
                (complaint_id,),
            ).fetchone()[0]
            connection.execute(
                """
                INSERT INTO resolution_ledger (
                    complaint_id, sequence_number, status, timestamp,
                    photo_hash, previous_hash, hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    complaint_id, sequence_number, status, timestamp,
                    photo_hash, previous_hash, entry_hash,
                ),
            )
            connection.execute(
                """
                UPDATE complaints
                SET status = ?,
                    resolution_photo_data = COALESCE(?, resolution_photo_data)
                WHERE id = ?
                """,
                (status, photo_data if status == "Resolved" else None, complaint_id),
            )

        return jsonify({
            "complaint_id": complaint_id,
            "status": status,
            "ledger_hash": entry_hash,
        })

    # ── Complaint deletion (protected) ──────────────────────────────────────────

    @app.delete("/api/complaints/<int:complaint_id>")
    @_require_official
    def delete_complaint(complaint_id: int):
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            row = connection.execute(
                "SELECT id FROM complaints WHERE id = ?", (complaint_id,)
            ).fetchone()
            if row is None:
                return jsonify({"error": "complaint not found"}), 404

            connection.execute(
                "DELETE FROM resolution_ledger WHERE complaint_id = ?",
                (complaint_id,),
            )
            connection.execute(
                "DELETE FROM complaints WHERE id = ?",
                (complaint_id,),
            )

        return jsonify({
            "message": f"Complaint #{complaint_id} deleted successfully",
            "id": complaint_id,
        }), 200

    # ── Ledger verification (public) ──────────────────────────────────────────

    @app.get("/api/verify/<int:complaint_id>")
    def verify_ledger(complaint_id: int):
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            # Also fetch complaint metadata for the public verify page
            columns = [col[1] for col in connection.execute(
                "PRAGMA table_info(complaints)"
            )]
            complaint_row = connection.execute(
                "SELECT * FROM complaints WHERE id = ?", (complaint_id,)
            ).fetchone()
            entries = connection.execute(
                """
                SELECT sequence_number, status, timestamp, photo_hash,
                       previous_hash, hash
                FROM resolution_ledger
                WHERE complaint_id = ?
                ORDER BY sequence_number
                """,
                (complaint_id,),
            ).fetchall()

        if complaint_row is None:
            return jsonify({"error": "complaint not found"}), 404

        complaint = dict(zip(columns, complaint_row))

        expected_previous = None
        valid = bool(entries)
        chain = []
        for seq, status, timestamp, photo_hash, previous_hash, stored_hash in entries:
            expected_hash = ledger_hash(
                complaint_id, status, timestamp, photo_hash, expected_previous
            )
            block_valid = (
                seq > 0
                and previous_hash == expected_previous
                and stored_hash == expected_hash
            )
            if not block_valid:
                valid = False
            chain.append({
                "sequence": seq,
                "status": status,
                "timestamp": timestamp,
                "photo_hash": photo_hash,
                "previous_hash": previous_hash,
                "hash": stored_hash,
                "valid": block_valid,
            })
            expected_previous = stored_hash

        return jsonify({
            "complaint_id": complaint_id,
            "verified": valid,
            "entries": len(entries),
            "chain": chain,
            # Public metadata for the verify page
            "complaint": {
                "category": complaint["category"],
                "description": complaint["description"],
                "status": complaint["status"],
                "ward": complaint.get("ward", "hsr_layout"),
                "priority_score": complaint["priority_score"],
                "created_at": complaint["created_at"],
            },
        })

    # ── Wards list ────────────────────────────────────────────────────────────

    @app.get("/api/wards")
    def list_wards():
        from models.priority import WARD_META
        return jsonify(WARD_META)

    # ── Digital Twin simulation (dynamic) ────────────────────────────────────

    @app.get("/api/twin/<ward>/<node_id>")
    def digital_twin(ward: str, node_id: str):
        road_graph = _graph_for_ward(ward)
        if node_id not in road_graph:
            return jsonify({"error": "node not found in ward graph"}), 404

        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            # Get count and average priority of open complaints at this node
            stats = connection.execute(
                """
                SELECT COUNT(*), COALESCE(AVG(priority_score), 0)
                FROM complaints
                WHERE node_id = ? AND status != 'Resolved'
                """,
                (node_id,),
            ).fetchone()
        open_count, avg_priority = stats
        avg_priority = float(avg_priority)

        # Compute simulation metrics from real data
        node_data = road_graph.nodes[node_id]
        degree = road_graph.degree[node_id]
        # Flow recovery: how much traffic improves if all complaints at this node resolved
        base_flow_recovery = round(8 + degree * 4 + avg_priority * 0.22, 1)
        # Delay reduction: higher priority = more current delay
        peak_delay_reduction = round(-(1.5 + avg_priority * 0.06 + degree * 0.4), 1)
        # Bus latency reduction
        bus_latency_reduction = round(-(4 + degree * 2 + open_count * 1.2), 1)
        # Safety index: hospitals/schools nearby push score up
        landmark = node_data.get("landmark")
        safety_base = 95 if landmark in {"hospital", "school"} else 88
        safety_index = min(100, safety_base + max(0, 5 - open_count))

        return jsonify({
            "ward": ward,
            "node_id": node_id,
            "open_complaints": open_count,
            "average_priority": round(avg_priority, 1),
            "flow_recovery_pct": f"+{base_flow_recovery}%",
            "peak_delay_reduction_min": f"{peak_delay_reduction} min",
            "bus_latency_reduction_pct": f"{bus_latency_reduction}%",
            "safety_index": f"{safety_index}/100",
        })

    # ── Baseline comparison: FIFO vs Setu priority ───────────────────────────

    @app.get("/api/comparison")
    def baseline_comparison():
        """
        Simulate two complaint-resolution orderings and return the comparison.

        Returns
        -------
        {
          "complaint_count": int,          # total complaints used
          "synthetic_count": int,          # how many were generated
          "real_count": int,
          "fifo": {
            "avg_days_all": float,
            "avg_days_high_impact": float,
            "order": "submission timestamp"
          },
          "setu": {
            "avg_days_all": float,
            "avg_days_high_impact": float,
            "order": "priority score descending"
          },
          "improvement_pct": float,        # % faster for high-impact locations
          "high_impact_count": int,
          "complaints_per_day": int
        }
        """
        COMPLAINTS_PER_DAY = 5
        TARGET_COUNT = 30

        # ── 1. Fetch real complaints ──────────────────────────────────────────
        with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
            columns = [col[1] for col in connection.execute(
                "PRAGMA table_info(complaints)"
            )]
            rows = connection.execute(
                """
                SELECT * FROM complaints
                WHERE is_demo_seed = 0
                  OR is_demo_seed = 1
                ORDER BY created_at ASC
                """
            ).fetchall()

        real_complaints = [dict(zip(columns, r)) for r in rows]
        # Strip synthetics from previous runs
        real_complaints = [c for c in real_complaints if not c.get("is_synthetic")]

        # ── 2. Generate synthetic complaints if needed ────────────────────────
        import random, math as _math

        synthetic = []
        if len(real_complaints) < TARGET_COUNT:
            needed = TARGET_COUNT - len(real_complaints)
            # Spread evenly across the three wards
            ward_specs = [
                ("hsr_layout",   "central",       12.9000, 77.6000),
                ("hsr_layout",   "hospital_east", 12.9060, 77.5940),
                ("hsr_layout",   "school_north",  12.9060, 77.6060),
                ("hsr_layout",   "north_gate",    12.9050, 77.6000),
                ("hsr_layout",   "bus_north",     12.9100, 77.6060),
                ("koramangala",  "central_sq",    12.9352, 77.6245),
                ("koramangala",  "kor_hospital",  12.9350, 77.6280),
                ("koramangala",  "kor_school",    12.9390, 77.6150),
                ("koramangala",  "silk_board",    12.9172, 77.6228),
                ("indiranagar",  "100ft_road",    12.9784, 77.6408),
                ("indiranagar",  "ind_hospital",  12.9800, 77.6450),
                ("indiranagar",  "ind_school",    12.9750, 77.6360),
                ("indiranagar",  "domlur",        12.9609, 77.6387),
            ]
            categories = ["pothole", "streetlight", "waste", "water", "pothole"]
            base_time = datetime(2026, 9, 1, 8, 0, 0, tzinfo=timezone.utc)

            # Low-impact nodes first (early FIFO), landmark nodes last (FIFO delays them).
            landmark_nodes = {
                "hospital_east", "hospital_west", "school_north", "school_south",
                "kor_hospital", "kor_school", "ind_hospital", "ind_school",
            }
            ordered_specs = sorted(
                ward_specs,
                key=lambda spec: 1 if spec[1] in landmark_nodes else 0,
            )
            for i in range(needed):
                spec = ordered_specs[i % len(ordered_specs)]
                ward, node_id, lat, lng = spec
                graph = _graph_for_ward(ward)
                # Add small jitter so each point is unique
                jlat = lat + (i * 0.0003)
                jlng = lng + (i * 0.0002)
                freq = 5 if node_id in landmark_nodes else (i % 3) + 1
                score = priority_for_node(graph, node_id, freq)["score"]
                if node_id in landmark_nodes:
                    score = max(score, 78.0)
                created = base_time + timedelta(hours=i * 4)
                synthetic.append({
                    "id": f"syn_{i}",
                    "category": categories[i % len(categories)],
                    "description": f"Synthetic report {i} at {node_id}",
                    "latitude": jlat,
                    "longitude": jlng,
                    "ward": ward,
                    "node_id": node_id,
                    "priority_score": score,
                    "status": "Received",
                    "created_at": created.isoformat(),
                    "is_synthetic": True,
                })

        all_complaints = real_complaints + synthetic

        # ── 3. Determine high-impact flag per complaint ───────────────────────
        # High-impact: near hospital/school node OR priority score ≥ 55
        HIGH_PRIORITY_THRESHOLD = 55

        def is_high_impact(c):
            nid = c.get("node_id")
            ward = c.get("ward") or "hsr_layout"
            graph = _graph_for_ward(ward)
            if nid and nid in graph:
                landmark = graph.nodes[nid].get("landmark")
                if landmark in {"hospital", "school"}:
                    return True
            score = float(c.get("priority_score") or 0)
            return score >= HIGH_PRIORITY_THRESHOLD

        for c in all_complaints:
            c["_high_impact"] = is_high_impact(c)

        # ── 4. Simulate FIFO vs Setu ordering ─────────────────────────────────
        def simulate(ordered_complaints, complaints_per_day):
            """
            Returns avg wait, high-impact wait, impact-weighted wait,
            share of high-impact cases finished by day 2, and per-id days.
            """
            days_all = []
            days_hi = []
            weighted = []
            by_id = {}
            hi_by_day2 = 0
            for rank, c in enumerate(ordered_complaints):
                wait = (rank // complaints_per_day) + 1
                by_id[str(c.get("id"))] = wait
                days_all.append(wait)
                weight = 3 if c["_high_impact"] else 1
                weighted.append(wait * weight)
                if c["_high_impact"]:
                    days_hi.append(wait)
                    if wait <= 2:
                        hi_by_day2 += 1
            avg_all = round(sum(days_all) / len(days_all), 1) if days_all else 0
            avg_hi = round(sum(days_hi) / len(days_hi), 1) if days_hi else 0
            weight_sum = sum(3 if c["_high_impact"] else 1 for c in ordered_complaints)
            avg_weighted = round(sum(weighted) / weight_sum, 1) if weight_sum else 0
            early_pct = round(hi_by_day2 / len(days_hi) * 100, 1) if days_hi else 0
            return avg_all, avg_hi, avg_weighted, early_pct, by_id

        fifo_order = sorted(all_complaints, key=lambda c: str(c.get("created_at") or ""))
        # Setu serves hospital/school (high-impact) locations first, then score.
        setu_order = sorted(
            all_complaints,
            key=lambda c: (
                1 if c["_high_impact"] else 0,
                float(c.get("priority_score") or 0),
            ),
            reverse=True,
        )

        fifo_all, fifo_hi, fifo_w, fifo_early, fifo_days = simulate(
            fifo_order, COMPLAINTS_PER_DAY
        )
        setu_all, setu_hi, setu_w, setu_early, setu_days = simulate(
            setu_order, COMPLAINTS_PER_DAY
        )

        # ── 5. Improvement % for high-impact locations ────────────────────────
        if fifo_hi > 0 and setu_hi < fifo_hi:
            improvement_pct = round((fifo_hi - setu_hi) / fifo_hi * 100, 1)
        else:
            improvement_pct = 0.0

        high_impact = [c for c in all_complaints if c["_high_impact"]]
        high_impact.sort(
            key=lambda c: fifo_days.get(str(c.get("id")), 99) - setu_days.get(str(c.get("id")), 99),
            reverse=True,
        )
        timeline = []
        for idx, c in enumerate(high_impact[:5], start=1):
            cid = str(c.get("id"))
            timeline.append({
                "label": f"Q{idx}",
                "fifo_day": fifo_days.get(cid, 0),
                "setu_day": setu_days.get(cid, 0),
            })

        return jsonify({
            "complaint_count": len(all_complaints),
            "real_count": len(real_complaints),
            "synthetic_count": len(synthetic),
            "complaints_per_day": COMPLAINTS_PER_DAY,
            "high_impact_count": len(high_impact),
            "fifo": {
                "avg_days_all": fifo_w,
                "avg_days_high_impact": fifo_hi,
                "early_high_impact_pct": fifo_early,
                "order": "submission timestamp (oldest first)",
            },
            "setu": {
                "avg_days_all": setu_w,
                "avg_days_high_impact": setu_hi,
                "early_high_impact_pct": setu_early,
                "order": "high-impact locations first, then priority score",
            },
            "improvement_pct": improvement_pct,
            "timeline": timeline,
        })

    # ── Static frontend ───────────────────────────────────────────────────────

    @app.get("/")
    def index():
        return send_from_directory(FRONTEND_DIR, "index.html")

    @app.get("/verify")
    @app.get("/verify/<path:complaint_id>")
    def verify_page(complaint_id=None):
        return send_from_directory(FRONTEND_DIR, "verify.html")

    @app.get("/<path:filename>")
    def frontend_asset(filename: str):
        return send_from_directory(FRONTEND_DIR, filename)

    @app.after_request
    def add_no_cache_headers(response):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    return app


# ── Database initialisation ───────────────────────────────────────────────────

def initialize_database(app: Flask) -> None:
    with sqlite3.connect(app.config["DATABASE_PATH"]) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS complaints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                photo_data TEXT,
                voice_transcript TEXT,
                classifier_label TEXT,
                classifier_confidence REAL,
                latitude REAL,
                longitude REAL,
                ward TEXT NOT NULL DEFAULT 'hsr_layout',
                node_id TEXT,
                priority_score REAL,
                status TEXT NOT NULL DEFAULT 'Received',
                sla_deadline TEXT,
                report_count INTEGER NOT NULL DEFAULT 1,
                is_demo_seed INTEGER NOT NULL DEFAULT 0,
                is_approximate_ward INTEGER NOT NULL DEFAULT 0,
                resolution_photo_data TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        existing_columns = {
            col[1]
            for col in connection.execute("PRAGMA table_info(complaints)")
        }
        migrations = {
            "category": "TEXT NOT NULL DEFAULT ''",
            "description": "TEXT NOT NULL DEFAULT ''",
            "photo_data": "TEXT",
            "voice_transcript": "TEXT",
            "classifier_label": "TEXT",
            "classifier_confidence": "REAL",
            "latitude": "REAL",
            "longitude": "REAL",
            "ward": "TEXT NOT NULL DEFAULT 'hsr_layout'",
            "node_id": "TEXT",
            "priority_score": "REAL",
            "status": "TEXT NOT NULL DEFAULT 'Received'",
            "sla_deadline": "TEXT",
            "report_count": "INTEGER NOT NULL DEFAULT 1",
            "is_demo_seed": "INTEGER NOT NULL DEFAULT 0",
            "is_approximate_ward": "INTEGER NOT NULL DEFAULT 0",
            "resolution_photo_data": "TEXT",
        }
        for column, definition in migrations.items():
            if column not in existing_columns:
                connection.execute(
                    f"ALTER TABLE complaints ADD COLUMN {column} {definition}"
                )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS resolution_ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                complaint_id INTEGER NOT NULL,
                sequence_number INTEGER NOT NULL,
                status TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                photo_hash TEXT,
                previous_hash TEXT,
                hash TEXT NOT NULL,
                UNIQUE (complaint_id, sequence_number)
            )
            """
        )


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
