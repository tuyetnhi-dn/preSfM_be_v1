import io
import os
from typing import Any

import cv2
import numpy as np
import torch

from app.model_definition import build_model


MODEL_PATH = os.getenv("MODEL_PATH", "/models/model.pth")

MODEL_ARCH = os.getenv("MODEL_ARCH", "Segformer")
ENCODER_NAME = os.getenv("ENCODER_NAME", "resnet50")
NUM_CLASSES = int(os.getenv("NUM_CLASSES", "2"))

INPUT_SIZE = int(os.getenv("INPUT_SIZE", "768"))
FOREGROUND_CLASS_ID = int(os.getenv("FOREGROUND_CLASS_ID", "1"))
MIN_FOREGROUND_RATIO = float(os.getenv("MIN_FOREGROUND_RATIO", "0.0"))

STRICT_LOAD = os.getenv("STRICT_LOAD", "false").lower() == "true"
DEVICE_NAME = os.getenv("DEVICE", "cpu")

IMAGENET_MEAN = np.array(
    [float(x) for x in os.getenv("MODEL_MEAN", "0.485,0.456,0.406").split(",")],
    dtype=np.float32,
)

IMAGENET_STD = np.array(
    [float(x) for x in os.getenv("MODEL_STD", "0.229,0.224,0.225").split(",")],
    dtype=np.float32,
)


def decode_image(image_bytes: bytes) -> np.ndarray:
    image_array = np.frombuffer(image_bytes, dtype=np.uint8)
    image_bgr = cv2.imdecode(image_array, cv2.IMREAD_COLOR)

    if image_bgr is None:
        raise ValueError("Cannot decode image")

    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    return image_rgb


def letterbox_square(image_np: np.ndarray, size: int = 768, pad_value: int = 0):
    orig_h, orig_w = image_np.shape[:2]

    scale = min(size / orig_w, size / orig_h)

    new_w = int(round(orig_w * scale))
    new_h = int(round(orig_h * scale))

    resized = cv2.resize(
        image_np,
        (new_w, new_h),
        interpolation=cv2.INTER_LINEAR,
    )

    pad_left = (size - new_w) // 2
    pad_right = size - new_w - pad_left

    pad_top = (size - new_h) // 2
    pad_bottom = size - new_h - pad_top

    padded = cv2.copyMakeBorder(
        resized,
        pad_top,
        pad_bottom,
        pad_left,
        pad_right,
        borderType=cv2.BORDER_CONSTANT,
        value=(pad_value, pad_value, pad_value),
    )

    meta = {
        "orig_h": orig_h,
        "orig_w": orig_w,
        "new_h": new_h,
        "new_w": new_w,
        "pad_top": pad_top,
        "pad_bottom": pad_bottom,
        "pad_left": pad_left,
        "pad_right": pad_right,
        "scale": scale,
    }

    return padded, meta


def image_to_tensor(image_np: np.ndarray) -> torch.Tensor:
    image = image_np.astype(np.float32) / 255.0
    image = (image - IMAGENET_MEAN) / IMAGENET_STD

    tensor = torch.from_numpy(image)
    tensor = tensor.permute(2, 0, 1)
    tensor = tensor.unsqueeze(0)
    tensor = tensor.float()

    return tensor


def encode_mask_png(mask: np.ndarray) -> bytes:
    success, encoded = cv2.imencode(".png", mask)

    if not success:
        raise RuntimeError("Cannot encode mask PNG")

    return encoded.tobytes()


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
        print(f"[Segmentation] INPUT_SIZE={INPUT_SIZE}")
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

    def predict_original_size_mask(self, image_bytes: bytes):
        original_image = decode_image(image_bytes)

        padded_image, meta = letterbox_square(
            original_image,
            size=INPUT_SIZE,
            pad_value=0,
        )

        tensor = image_to_tensor(padded_image).to(self.device)

        with torch.no_grad():
            logits = self.model(tensor)

        if logits.shape[-2:] != (INPUT_SIZE, INPUT_SIZE):
            logits = torch.nn.functional.interpolate(
                logits,
                size=(INPUT_SIZE, INPUT_SIZE),
                mode="bilinear",
                align_corners=False,
            )

        pred_square = torch.argmax(logits, dim=1)[0]
        pred_square = pred_square.detach().cpu().numpy().astype(np.uint8)

        top = meta["pad_top"]
        left = meta["pad_left"]
        new_h = meta["new_h"]
        new_w = meta["new_w"]

        pred_unpadded = pred_square[
            top:top + new_h,
            left:left + new_w,
        ]

        pred_original_size = cv2.resize(
            pred_unpadded,
            (meta["orig_w"], meta["orig_h"]),
            interpolation=cv2.INTER_NEAREST,
        ).astype(np.uint8)

        mask_binary = (pred_original_size == FOREGROUND_CLASS_ID).astype(np.uint8)

        foreground_ratio = float(np.count_nonzero(mask_binary)) / float(
            meta["orig_w"] * meta["orig_h"]
        )

        if foreground_ratio < MIN_FOREGROUND_RATIO:
            return {
                "mask": None,
                "meta": meta,
                "foreground_ratio": foreground_ratio,
            }

        mask_255 = (mask_binary * 255).astype(np.uint8)

        return {
            "mask": mask_255,
            "meta": meta,
            "foreground_ratio": foreground_ratio,
        }