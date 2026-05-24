from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response

from app.inference import (
    ENCODER_NAME,
    FOREGROUND_CLASS_ID,
    INPUT_SIZE,
    MODEL_ARCH,
    MODEL_PATH,
    NUM_CLASSES,
    SegmentationModel,
    encode_mask_png,
)


app = FastAPI(title="PreSfM Segmentation Service")

segmenter: SegmentationModel | None = None


@app.on_event("startup")
def startup():
    global segmenter
    segmenter = SegmentationModel()


@app.get("/health")
def health():
    return {
        "service": "segmentation-service",
        "status": "ok",
        "modelLoaded": segmenter is not None,
    }


@app.get("/model-info")
def model_info():
    return {
        "modelPath": MODEL_PATH,
        "framework": "segmentation_models_pytorch",
        "modelArch": MODEL_ARCH,
        "encoderName": ENCODER_NAME,
        "numClasses": NUM_CLASSES,
        "foregroundClassId": FOREGROUND_CLASS_ID,
        "inputSize": INPUT_SIZE,
        "resizePolicy": "letterbox_square_before_model_only",
        "maskOutputSize": "original_image_size",
    }


@app.post("/segment")
async def segment(image: UploadFile = File(...)):
    if segmenter is None:
        raise HTTPException(status_code=503, detail="Model is not loaded")

    try:
        image_bytes = await image.read()

        result = segmenter.predict_original_size_mask(image_bytes)

        mask = result["mask"]

        if mask is None:
            return Response(status_code=204)

        mask_png = encode_mask_png(mask)

        return Response(
            content=mask_png,
            media_type="image/png",
            headers={
                "X-Original-Width": str(result["meta"]["orig_w"]),
                "X-Original-Height": str(result["meta"]["orig_h"]),
                "X-Foreground-Ratio": str(result["foreground_ratio"]),
            },
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc