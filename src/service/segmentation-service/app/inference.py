import io
import os
from typing import Any

import cv2
import numpy as np
import torch
from PIL import Image

from app.model_definition import build_model


MODEL_PATH = os.getenv("MODEL_PATH", "/models/model.pth")

MODEL_ARCH = os.getenv("MODEL_ARCH", "Segformer")
ENCODER_NAME = os.getenv("ENCODER_NAME", "resnet50")
NUM_CLASSES = int(os.getenv("NUM_CLASSES", "2"))

TARGET_HEIGHT = int(os.getenv("TARGET_HEIGHT", "768"))
TARGET_WIDTH = int(os.getenv("TARGET_WIDTH", "768"))

FOREGROUND_CLASS_ID = int(os.getenv("FOREGROUND_CLASS_ID", "1"))
MIN_FOREGROUND_RATIO = float(os.getenv("MIN_FOREGROUND_RATIO", "0.001"))

STRICT_LOAD = os.getenv("STRICT_LOAD", "true").lower() == "true"
DEVICE_NAME = os.getenv("DEVICE", "cpu")

MEAN = [
    float(x)
    for x in os.getenv("MODEL_MEAN", "0.485,0.456,0.406").split(",")
]

STD = [
    float(x)
    for x in os.getenv("MODEL_STD", "0.229,0.224,0.225").split(",")
]


class SegmentationModel:
    def __init__(self):
        self.device = torch.device(
            "cuda"
            if DEVICE_NAME == "cuda" and torch.cuda.is_available()
            else "cpu"
        )

        self.model = self.load_model()
        self.model.to(self.device)
        self.model.eval()

    def load_model(self):
        if not os.path.exists(MODEL_PATH):
            raise FileNotFoundError(f"MODEL_PATH not found: {MODEL_PATH}")

        model = build_model(
            arch=MODEL_ARCH,
            encoder_name=ENCODER_NAME,
            num_classes=NUM_CLASSES,
        )

        checkpoint = torch.load(
            MODEL_PATH,
            map_location=self.device,
            weights_only=False,
        )

        state_dict = self.extract_state_dict(checkpoint)
        state_dict = self.clean_state_dict_keys(state_dict)

        missing_keys, unexpected_keys = model.load_state_dict(
            state_dict,
            strict=STRICT_LOAD,
        )

        print("[Segmentation] model loaded")
        print(f"[Segmentation] MODEL_PATH={MODEL_PATH}")
        print(f"[Segmentation] MODEL_ARCH={MODEL_ARCH}")
        print(f"[Segmentation] ENCODER_NAME={ENCODER_NAME}")
        print(f"[Segmentation] NUM_CLASSES={NUM_CLASSES}")
        print(f"[Segmentation] TARGET_HEIGHT={TARGET_HEIGHT}")
        print(f"[Segmentation] TARGET_WIDTH={TARGET_WIDTH}")
        print(f"[Segmentation] FOREGROUND_CLASS_ID={FOREGROUND_CLASS_ID}")
        print(f"[Segmentation] DEVICE={self.device}")
        print(f"[Segmentation] STRICT_LOAD={STRICT_LOAD}")

        if missing_keys:
            print(f"[WARN] Missing keys count: {len(missing_keys)}")
            print(f"[WARN] First missing keys: {missing_keys[:20]}")

        if unexpected_keys:
            print(f"[WARN] Unexpected keys count: {len(unexpected_keys)}")
            print(f"[WARN] First unexpected keys: {unexpected_keys[:20]}")

        return model

    def extract_state_dict(self, checkpoint: Any):
        if isinstance(checkpoint, dict):
            if "model_state" in checkpoint:
                return checkpoint["model_state"]

            if "state_dict" in checkpoint:
                return checkpoint["state_dict"]

            if "model_state_dict" in checkpoint:
                return checkpoint["model_state_dict"]

        return checkpoint

    def clean_state_dict_keys(self, state_dict):
        cleaned = {}

        for key, value in state_dict.items():
            new_key = key

            if new_key.startswith("module."):
                new_key = new_key.replace("module.", "", 1)

            cleaned[new_key] = value

        return cleaned

    def preprocess(self, image_bytes: bytes) -> torch.Tensor:
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        image = image.resize(
            (TARGET_WIDTH, TARGET_HEIGHT),
            Image.BILINEAR,
        )

        array = np.asarray(image).astype(np.float32) / 255.0

        mean = np.array(MEAN, dtype=np.float32).reshape(1, 1, 3)
        std = np.array(STD, dtype=np.float32).reshape(1, 1, 3)

        array = (array - mean) / std

        array = np.transpose(array, (2, 0, 1))

        tensor = torch.from_numpy(array).float().unsqueeze(0)

        return tensor.to(self.device)

    def predict(self, image_bytes: bytes) -> np.ndarray | None:
        tensor = self.preprocess(image_bytes)

        with torch.no_grad():
            logits = self.model(tensor)

        if logits.shape[-2:] != (TARGET_HEIGHT, TARGET_WIDTH):
            logits = torch.nn.functional.interpolate(
                logits,
                size=(TARGET_HEIGHT, TARGET_WIDTH),
                mode="bilinear",
                align_corners=False,
            )

        pred = torch.argmax(logits, dim=1)[0]
        pred = pred.detach().cpu().numpy().astype(np.uint8)

        mask = (pred == FOREGROUND_CLASS_ID).astype(np.uint8) * 255

        foreground_ratio = float(np.count_nonzero(mask)) / float(
            TARGET_HEIGHT * TARGET_WIDTH
        )

        if foreground_ratio < MIN_FOREGROUND_RATIO:
            return None

        mask = self.clean_mask(mask)

        return mask

    def clean_mask(self, mask: np.ndarray) -> np.ndarray:
        kernel = np.ones((5, 5), np.uint8)

        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

        return mask


def encode_mask_png(mask: np.ndarray) -> bytes:
    if mask.shape[:2] != (TARGET_HEIGHT, TARGET_WIDTH):
        mask = cv2.resize(
            mask,
            (TARGET_WIDTH, TARGET_HEIGHT),
            interpolation=cv2.INTER_NEAREST,
        )

    success, encoded = cv2.imencode(".png", mask)

    if not success:
        raise RuntimeError("Cannot encode mask PNG")

    return encoded.tobytes()