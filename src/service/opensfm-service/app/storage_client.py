import mimetypes
import os
from pathlib import Path

import requests


STORAGE_SERVICE_URL = os.getenv(
    "STORAGE_SERVICE_URL",
    "http://storage-service:8004",
)


def download_storage_file(storage_file_id: str) -> bytes:
    url = f"{STORAGE_SERVICE_URL}/storage/files/{storage_file_id}/download"

    response = requests.get(url, timeout=180)

    if not response.ok:
        raise RuntimeError(
            f"Cannot download storage file {storage_file_id}: {response.text}"
        )

    return response.content


def upload_file(path: str, bucket: str, object_path: str, dataset_id: str):
    url = f"{STORAGE_SERVICE_URL}/storage/upload"
    file_path = Path(path)
    mime_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"

    with file_path.open("rb") as file:
        response = requests.post(
            url,
            files={
                "file": (file_path.name, file, mime_type),
            },
            data={
                "bucket": bucket,
                "path": object_path,
                "datasetId": dataset_id,
            },
            timeout=600,
        )

    if not response.ok:
        raise RuntimeError(f"Cannot upload file {path}: {response.text}")

    return response.json()