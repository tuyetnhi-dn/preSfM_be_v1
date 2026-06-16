import os
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException

from app.dataset_builder import build_processed_dataset, build_raw_dataset
from app.evaluator import compare_metrics, extract_reconstruction_metrics
from app.opensfm_runner import run_opensfm_pipeline
from app.schemas import CompareOpenSfMInput
from app.storage_client import upload_file


WORKSPACE_ROOT = Path(os.getenv("OPENSFM_WORKSPACE", "/workspace/opensfm-runs"))
DEFAULT_BUCKET = os.getenv("SUPABASE_DEFAULT_BUCKET", "presfm")


app = FastAPI(title="PreSfM OpenSfM Service")


@app.get("/opensfm/health")
def health():
    return {
        "service": "opensfm-service",
        "status": "ok",
    }


@app.post("/opensfm/compare")
def compare_opensfm(input_data: CompareOpenSfMInput):
    try:
        if len(input_data.rawImages) == 0:
            raise RuntimeError("rawImages is empty")

        if len(input_data.processedPairs) == 0:
            raise RuntimeError("processedPairs is empty")

        compare_run_id = str(uuid.uuid4())

        base_dir = WORKSPACE_ROOT / input_data.videoId / compare_run_id
        raw_dir = base_dir / "raw_flow"
        processed_dir = base_dir / "processed_flow"

        build_raw_dataset(raw_dir, input_data.rawImages)
        build_processed_dataset(processed_dir, input_data.processedPairs)

        raw_result = run_opensfm_pipeline(raw_dir, input_data.runDense)
        processed_result = run_opensfm_pipeline(processed_dir, input_data.runDense)

        raw_metrics = extract_reconstruction_metrics(raw_result)
        processed_metrics = extract_reconstruction_metrics(processed_result)

        comparison = compare_metrics(raw_metrics, processed_metrics)

        raw_ply_upload = None
        processed_ply_upload = None
        raw_report_upload = None
        processed_report_upload = None

        if raw_metrics["plyPath"]:
            raw_ply_upload = upload_file(
                raw_metrics["plyPath"],
                DEFAULT_BUCKET,
                f"datasets/{input_data.datasetId}/videos/{input_data.videoId}/opensfm/{compare_run_id}/file1_raw.ply",
                input_data.datasetId,
            )

        if processed_metrics["plyPath"]:
            processed_ply_upload = upload_file(
                processed_metrics["plyPath"],
                DEFAULT_BUCKET,
                f"datasets/{input_data.datasetId}/videos/{input_data.videoId}/opensfm/{compare_run_id}/file2_processed.ply",
                input_data.datasetId,
            )

        if raw_metrics["reportPath"]:
            raw_report_upload = upload_file(
                raw_metrics["reportPath"],
                DEFAULT_BUCKET,
                f"datasets/{input_data.datasetId}/videos/{input_data.videoId}/opensfm/{compare_run_id}/raw_report.pdf",
                input_data.datasetId,
            )

        if processed_metrics["reportPath"]:
            processed_report_upload = upload_file(
                processed_metrics["reportPath"],
                DEFAULT_BUCKET,
                f"datasets/{input_data.datasetId}/videos/{input_data.videoId}/opensfm/{compare_run_id}/processed_report.pdf",
                input_data.datasetId,
            )

        return {
            "compareRunId": compare_run_id,
            "rawFlow": {
                "name": "raw_flow",
                "datasetPath": str(raw_dir),
                "imageCount": len(input_data.rawImages),
                "ply": raw_ply_upload,
                "report": raw_report_upload,
                "metrics": raw_metrics,
            },
            "processedFlow": {
                "name": "processed_flow",
                "datasetPath": str(processed_dir),
                "imageCount": len(input_data.processedPairs),
                "ply": processed_ply_upload,
                "report": processed_report_upload,
                "metrics": processed_metrics,
            },
            "comparison": comparison,
        }

    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc