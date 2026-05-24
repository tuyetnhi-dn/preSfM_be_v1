from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response

from app.inference import (
    ENCODER_NAME,
    FOREGROUND_CLASS_ID,
    MODEL_ARCH,
    MODEL_PATH,
    NUM_CLASSES,
    TARGET_HEIGHT,
    TARGET_WIDTH,
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
        "targetHeight": TARGET_HEIGHT,
        "targetWidth": TARGET_WIDTH,
    }


@app.post("/segment")
async def segment(image: UploadFile = File(...)):
    if segmenter is None:
        raise HTTPException(status_code=503, detail="Model is not loaded")

    try:
        image_bytes = await image.read()

        mask = segmenter.predict(image_bytes)

        if mask is None:
            return Response(status_code=204)

        mask_png = encode_mask_png(mask)

        return Response(
            content=mask_png,
            media_type="image/png",
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc