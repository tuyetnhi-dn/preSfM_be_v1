import json
import os
import subprocess
from pathlib import Path


OPENSFM_BIN = os.getenv("OPENSFM_BIN", "/opt/OpenSfM/bin/opensfm")
OPENSFM_ROOT = os.getenv("OPENSFM_ROOT", "/opt/OpenSfM")


def run_command(command: list[str]):
    process = subprocess.run(
        command,
        cwd=OPENSFM_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    if process.returncode != 0:
        raise RuntimeError(
            f"Command failed: {' '.join(command)}\n"
            f"STDOUT:\n{process.stdout}\n"
            f"STDERR:\n{process.stderr}"
        )

    return {
        "stdout": process.stdout,
        "stderr": process.stderr,
    }


def load_json_if_exists(path: Path):
    if not path.exists():
        return None

    return json.loads(path.read_text(encoding="utf-8"))


def run_opensfm_pipeline(dataset_dir: Path, run_dense: bool = True):
    commands = [
        "extract_metadata",
        "detect_features",
        "match_features",
        "create_tracks",
        "reconstruct",
        "compute_statistics",
        "export_report",
    ]

    logs = []

    for command in commands:
        logs.append(run_command([OPENSFM_BIN, command, str(dataset_dir)]))

    if run_dense:
        logs.append(run_command([OPENSFM_BIN, "undistort", str(dataset_dir)]))
        logs.append(run_command([OPENSFM_BIN, "compute_depthmaps", str(dataset_dir)]))
        ply_path = dataset_dir / "undistorted" / "depthmaps" / "merged.ply"
    else:
        logs.append(run_command([OPENSFM_BIN, "export_ply", str(dataset_dir)]))
        ply_path = dataset_dir / "reconstruction.ply"

    stats_path = dataset_dir / "stats" / "stats.json"
    report_path = dataset_dir / "stats" / "report.pdf"
    reconstruction_path = dataset_dir / "reconstruction.json"

    return {
        "datasetPath": str(dataset_dir),
        "statsPath": str(stats_path) if stats_path.exists() else None,
        "reportPath": str(report_path) if report_path.exists() else None,
        "reconstructionPath": str(reconstruction_path)
        if reconstruction_path.exists()
        else None,
        "plyPath": str(ply_path) if ply_path.exists() else None,
        "stats": load_json_if_exists(stats_path),
        "reconstruction": load_json_if_exists(reconstruction_path),
        "logs": logs,
    }