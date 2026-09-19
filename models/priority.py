"""
Priority scoring and road-network graph for Setu.

Architecture
────────────
Each ward is an independent NetworkX graph keyed in WARD_GRAPHS.
Adding a new ward requires only a new entry in _WARD_DEFINITIONS —
no rebuild of existing logic needed.

Priority formula (0-100 scale)
  0.40 × route connectivity  (degree / max_degree capped at 4)
  0.35 × landmark proximity  (1 − metres_to_nearest / 700m)
  0.25 × report frequency    (reports / 5, capped at 1.0)
"""

import math
from typing import TypedDict

import networkx as nx


# ─────────────────────────────────────────────────────────────────────────────
# Ward definition types
# ─────────────────────────────────────────────────────────────────────────────

class NodeDef(TypedDict):
    lat: float
    lng: float
    landmark: str | None   # "school" | "hospital" | None


class WardDef(TypedDict):
    display_name: str
    nodes: dict[str, NodeDef]
    edges: list[tuple[str, str]]


# ─────────────────────────────────────────────────────────────────────────────
# Ward definitions
# Add any new ward here — zero changes elsewhere needed.
# ─────────────────────────────────────────────────────────────────────────────

_WARD_DEFINITIONS: dict[str, WardDef] = {
    "hsr_layout": {
        "display_name": "HSR Layout (Ward 174)",
        "nodes": {
            "central":       {"lat": 12.9000, "lng": 77.6000, "landmark": None},
            "north_gate":    {"lat": 12.9050, "lng": 77.6000, "landmark": None},
            "south_gate":    {"lat": 12.8950, "lng": 77.6000, "landmark": None},
            "east_market":   {"lat": 12.9000, "lng": 77.6060, "landmark": None},
            "west_market":   {"lat": 12.9000, "lng": 77.5940, "landmark": None},
            "school_north":  {"lat": 12.9060, "lng": 77.6060, "landmark": "school"},
            "school_south":  {"lat": 12.8940, "lng": 77.5940, "landmark": "school"},
            "hospital_east": {"lat": 12.9060, "lng": 77.5940, "landmark": "hospital"},
            "hospital_west": {"lat": 12.8940, "lng": 77.6060, "landmark": "hospital"},
            "park_north":    {"lat": 12.9100, "lng": 77.6000, "landmark": None},
            "park_south":    {"lat": 12.8900, "lng": 77.6000, "landmark": None},
            "bus_north":     {"lat": 12.9100, "lng": 77.6060, "landmark": None},
            "bus_south":     {"lat": 12.8900, "lng": 77.5940, "landmark": None},
            "bridge_east":   {"lat": 12.9000, "lng": 77.6120, "landmark": None},
            "bridge_west":   {"lat": 12.9000, "lng": 77.5880, "landmark": None},
        },
        "edges": [
            ("central", "north_gate"),
            ("central", "south_gate"),
            ("central", "east_market"),
            ("central", "west_market"),
            ("north_gate", "park_north"),
            ("south_gate", "park_south"),
            ("east_market", "bridge_east"),
            ("west_market", "bridge_west"),
            ("north_gate", "school_north"),
            ("north_gate", "hospital_east"),
            ("south_gate", "school_south"),
            ("south_gate", "hospital_west"),
            ("school_north", "bus_north"),
            ("hospital_east", "bus_north"),
            ("school_south", "bus_south"),
            ("hospital_west", "bus_south"),
            ("bus_north", "bridge_east"),
            ("bus_south", "bridge_west"),
        ],
    },

    "koramangala": {
        "display_name": "Koramangala (Ward 151)",
        "nodes": {
            "central_sq":    {"lat": 12.9352, "lng": 77.6245, "landmark": None},
            "forum_mall":    {"lat": 12.9344, "lng": 77.6101, "landmark": None},
            "5th_block":     {"lat": 12.9406, "lng": 77.6189, "landmark": None},
            "7th_block":     {"lat": 12.9279, "lng": 77.6201, "landmark": None},
            "kor_hospital":  {"lat": 12.9350, "lng": 77.6280, "landmark": "hospital"},
            "kor_school":    {"lat": 12.9390, "lng": 77.6150, "landmark": "school"},
            "ejipura":       {"lat": 12.9305, "lng": 77.6150, "landmark": None},
            "silk_board":    {"lat": 12.9172, "lng": 77.6228, "landmark": None},
        },
        "edges": [
            ("central_sq", "forum_mall"),
            ("central_sq", "5th_block"),
            ("central_sq", "7th_block"),
            ("central_sq", "kor_hospital"),
            ("5th_block", "kor_school"),
            ("forum_mall", "ejipura"),
            ("7th_block", "ejipura"),
            ("ejipura", "silk_board"),
            ("kor_school", "5th_block"),
        ],
    },

    "indiranagar": {
        "display_name": "Indiranagar (Ward 81)",
        "nodes": {
            "100ft_road":    {"lat": 12.9784, "lng": 77.6408, "landmark": None},
            "12th_main":     {"lat": 12.9716, "lng": 77.6412, "landmark": None},
            "ind_metro":     {"lat": 12.9716, "lng": 77.6395, "landmark": None},
            "ind_hospital":  {"lat": 12.9800, "lng": 77.6450, "landmark": "hospital"},
            "ind_school":    {"lat": 12.9750, "lng": 77.6360, "landmark": "school"},
            "domlur":        {"lat": 12.9609, "lng": 77.6387, "landmark": None},
            "hal_old":       {"lat": 12.9841, "lng": 77.6494, "landmark": None},
        },
        "edges": [
            ("100ft_road", "12th_main"),
            ("100ft_road", "ind_hospital"),
            ("100ft_road", "hal_old"),
            ("12th_main", "ind_metro"),
            ("12th_main", "domlur"),
            ("ind_metro", "ind_school"),
            ("ind_school", "domlur"),
        ],
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# Build graphs from definitions
# ─────────────────────────────────────────────────────────────────────────────

def _build_graph(ward_def: WardDef) -> nx.Graph:
    graph = nx.Graph()
    for node_id, attrs in ward_def["nodes"].items():
        graph.add_node(
            node_id,
            latitude=attrs["lat"],
            longitude=attrs["lng"],
            landmark=attrs["landmark"],
        )
    graph.add_edges_from(ward_def["edges"])
    return graph


# Public registry of compiled graphs and metadata
WARD_GRAPHS: dict[str, nx.Graph] = {
    ward_id: _build_graph(definition)
    for ward_id, definition in _WARD_DEFINITIONS.items()
}

WARD_META: list[dict] = [
    {
        "id": ward_id,
        "display_name": definition["display_name"],
        "node_count": len(definition["nodes"]),
        "edge_count": len(definition["edges"]),
    }
    for ward_id, definition in _WARD_DEFINITIONS.items()
]

# Backwards-compat alias used by legacy callers
def build_seed_graph() -> nx.Graph:
    return WARD_GRAPHS["hsr_layout"]


# ─────────────────────────────────────────────────────────────────────────────
# Geometry helpers
# ─────────────────────────────────────────────────────────────────────────────

def distance_in_meters(
    latitude_a: float,
    longitude_a: float,
    latitude_b: float,
    longitude_b: float,
) -> float:
    earth_radius_meters = 6_371_000
    lat_delta = math.radians(latitude_b - latitude_a)
    lng_delta = math.radians(longitude_b - longitude_a)
    first_term = (
        math.sin(lat_delta / 2) ** 2
        + math.cos(math.radians(latitude_a))
        * math.cos(math.radians(latitude_b))
        * math.sin(lng_delta / 2) ** 2
    )
    return 2 * earth_radius_meters * math.asin(math.sqrt(first_term))


def nearest_node(graph: nx.Graph, latitude: float, longitude: float) -> str:
    return min(
        graph.nodes,
        key=lambda nid: distance_in_meters(
            latitude, longitude,
            graph.nodes[nid]["latitude"],
            graph.nodes[nid]["longitude"],
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Priority scoring
# ─────────────────────────────────────────────────────────────────────────────

def priority_for_node(
    graph: nx.Graph,
    node_id: str,
    report_frequency: int,
) -> dict:
    node = graph.nodes[node_id]

    landmark_distances = [
        distance_in_meters(
            node["latitude"], node["longitude"],
            graph.nodes[nid]["latitude"],
            graph.nodes[nid]["longitude"],
        )
        for nid in graph.nodes
        if graph.nodes[nid]["landmark"] in {"school", "hospital"}
    ]
    nearest_landmark_meters = min(landmark_distances) if landmark_distances else 9999

    connectivity = min(graph.degree[node_id] / 4, 1)
    landmark_proximity = max(0, 1 - nearest_landmark_meters / 700)
    frequency = min(report_frequency / 5, 1)

    score = round(100 * (
        0.40 * connectivity
        + 0.35 * landmark_proximity
        + 0.25 * frequency
    ), 2)

    return {
        "node_id": node_id,
        "score": score,
        "connectivity": round(connectivity, 3),
        "landmark_proximity": round(landmark_proximity, 3),
        "report_frequency": report_frequency,
        "nearest_landmark_meters": round(nearest_landmark_meters, 1),
    }
