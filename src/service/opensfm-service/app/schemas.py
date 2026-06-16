from pydantic import BaseModel
from typing import List


class RawImageInput(BaseModel):
    frameIndex: int
    imageStorageFileId: str


class ProcessedPairInput(BaseModel):
    frameIndex: int
    imageStorageFileId: str
    maskStorageFileId: str


class CompareOpenSfMInput(BaseModel):
    videoId: str
    datasetId: str
    rawImages: List[RawImageInput]
    processedPairs: List[ProcessedPairInput]
    runDense: bool = True