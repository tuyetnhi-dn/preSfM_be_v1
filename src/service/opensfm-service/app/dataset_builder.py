import shutil
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

from app.storage_client import download_storage_file


def ensure_clean_dir(path: Path):
    if path.exists():
        shutil.rmtree(path)

    path.mkdir(parents=True, exist_ok=True)


def image_name(frame_index: int):
    return f"frame_{frame_index + 1:06d}.jpg"


def mask_name_for_image(image_filename: str):
    return f"{image_filename}.png"


def write_config(dataset_dir: Path):
    config = """feature_type: SIFT
feature_process_size: 2048
matcher_type: FLANN
matching_order_neighbors: 8
matching_gps_neighbors: 0
matching_time_neighbors: 0
processes: 4
depthmap_resolution: 640
depthmap_num_neighbors: 10
depthmap_min_consistent_views: 3
"""
    (dataset_dir / "config.yaml").write_text(config, encoding="utf-8")


def save_image_as_jpg(image_bytes: bytes, image_path: Path):
    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    image.save(image_path, format="JPEG", quality=95)


def create_white_opensfm_mask(image_path: Path, mask_path: Path):
    with Image.open(image_path) as image:
        width, height = image.size

    mask = Image.new("L", (width, height), 255)
    mask.save(mask_path)


def convert_model_mask_to_opensfm_mask(
    mask_bytes: bytes,
    image_path: Path,
    mask_path: Path,
):
    with Image.open(image_path) as image:
        width, height = image.size

    mask_image = Image.open(BytesIO(mask_bytes)).convert("L")
    mask_image = mask_image.resize((width, height), Image.Resampling.NEAREST)

    arr = np.array(mask_image)

    dynamic_object = arr > 127
    opensfm_mask = np.where(dynamic_object, 0, 255).astype(np.uint8)

    Image.fromarray(opensfm_mask, mode="L").save(mask_path)


def build_raw_dataset(dataset_dir: Path, raw_images):
    ensure_clean_dir(dataset_dir)

    images_dir = dataset_dir / "images"
    masks_dir = dataset_dir / "masks"

    images_dir.mkdir(parents=True, exist_ok=True)
    masks_dir.mkdir(parents=True, exist_ok=True)

    for item in raw_images:
        filename = image_name(item.frameIndex)

        image_path = images_dir / filename
        mask_path = masks_dir / mask_name_for_image(filename)

        image_bytes = download_storage_file(item.imageStorageFileId)

        save_image_as_jpg(image_bytes, image_path)
        create_white_opensfm_mask(image_path, mask_path)

    write_config(dataset_dir)


def build_processed_dataset(dataset_dir: Path, processed_pairs):
    ensure_clean_dir(dataset_dir)

    images_dir = dataset_dir / "images"
    masks_dir = dataset_dir / "masks"

    images_dir.mkdir(parents=True, exist_ok=True)
    masks_dir.mkdir(parents=True, exist_ok=True)

    if len(processed_pairs) == 0:
        raise RuntimeError("processedPairs is empty")

    for item in processed_pairs:
        filename = image_name(item.frameIndex)

        image_path = images_dir / filename
        mask_path = masks_dir / mask_name_for_image(filename)

        image_bytes = download_storage_file(item.imageStorageFileId)
        mask_bytes = download_storage_file(item.maskStorageFileId)

        save_image_as_jpg(image_bytes, image_path)
        convert_model_mask_to_opensfm_mask(mask_bytes, image_path, mask_path)

    write_config(dataset_dir)