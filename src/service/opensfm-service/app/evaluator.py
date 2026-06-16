from pathlib import Path
from typing import Any


def count_ply_vertices(ply_path: str | None) -> int:
    if not ply_path:
        return 0

    path = Path(ply_path)

    if not path.exists():
        return 0

    with path.open("rb") as file:
        for raw_line in file:
            line = raw_line.decode("utf-8", errors="ignore").strip()

            if line.startswith("element vertex"):
                parts = line.split()
                return int(parts[-1])

            if line == "end_header":
                break

    return 0


def find_first_number_by_key(obj: Any, keywords: list[str]):
    if isinstance(obj, dict):
        for key, value in obj.items():
            key_lower = str(key).lower()

            if all(keyword in key_lower for keyword in keywords):
                if isinstance(value, int | float):
                    return float(value)

            nested = find_first_number_by_key(value, keywords)

            if nested is not None:
                return nested

    if isinstance(obj, list):
        for item in obj:
            nested = find_first_number_by_key(item, keywords)

            if nested is not None:
                return nested

    return None


def extract_reconstruction_metrics(result: dict):
    reconstruction = result.get("reconstruction")
    stats = result.get("stats")
    ply_path = result.get("plyPath")

    reconstructed_images = 0
    sparse_points = 0
    reconstruction_count = 0

    if reconstruction:
        reconstruction_count = len(reconstruction)

        if len(reconstruction) > 0:
            largest = max(
                reconstruction,
                key=lambda item: len(item.get("shots", {})),
            )

            reconstructed_images = len(largest.get("shots", {}))
            sparse_points = len(largest.get("points", {}))

    dense_points = count_ply_vertices(ply_path)

    avg_reprojection_error = None

    if stats:
        avg_reprojection_error = (
            find_first_number_by_key(stats, ["reprojection", "error"])
            or find_first_number_by_key(stats, ["average", "error"])
        )

    return {
        "reconstructionCount": reconstruction_count,
        "reconstructedImages": reconstructed_images,
        "sparsePointCount": sparse_points,
        "densePointCount": dense_points,
        "avgReprojectionError": avg_reprojection_error,
        "plyPath": ply_path,
        "statsPath": result.get("statsPath"),
        "reportPath": result.get("reportPath"),
        "reconstructionPath": result.get("reconstructionPath"),
    }


def percent_change(old_value: float, new_value: float):
    if old_value == 0:
        return None

    return ((new_value - old_value) / old_value) * 100


def percent_improvement_lower_is_better(old_value, new_value):
    if old_value is None or new_value is None or old_value == 0:
        return None

    return ((old_value - new_value) / old_value) * 100


def compare_metrics(raw_metrics: dict, processed_metrics: dict):
    dense_point_gain_percent = percent_change(
        raw_metrics["densePointCount"],
        processed_metrics["densePointCount"],
    )

    sparse_point_gain_percent = percent_change(
        raw_metrics["sparsePointCount"],
        processed_metrics["sparsePointCount"],
    )

    reprojection_error_improvement_percent = percent_improvement_lower_is_better(
        raw_metrics["avgReprojectionError"],
        processed_metrics["avgReprojectionError"],
    )

    processed_better = (
        processed_metrics["reconstructedImages"] >= raw_metrics["reconstructedImages"]
        and processed_metrics["densePointCount"] >= raw_metrics["densePointCount"]
    )

    return {
        "rawReconstructedImages": raw_metrics["reconstructedImages"],
        "processedReconstructedImages": processed_metrics["reconstructedImages"],
        "reconstructedImageGain": processed_metrics["reconstructedImages"]
        - raw_metrics["reconstructedImages"],
        "rawSparsePointCount": raw_metrics["sparsePointCount"],
        "processedSparsePointCount": processed_metrics["sparsePointCount"],
        "sparsePointGainPercent": sparse_point_gain_percent,
        "rawDensePointCount": raw_metrics["densePointCount"],
        "processedDensePointCount": processed_metrics["densePointCount"],
        "densePointGainPercent": dense_point_gain_percent,
        "rawAvgReprojectionError": raw_metrics["avgReprojectionError"],
        "processedAvgReprojectionError": processed_metrics["avgReprojectionError"],
        "reprojectionErrorImprovementPercent": reprojection_error_improvement_percent,
        "conclusion": "processed_flow_better" if processed_better else "needs_manual_review",
    }