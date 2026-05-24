import torch
import torch.nn as nn
import torch.nn.functional as F
import segmentation_models_pytorch as smp


class HVSegmentation(nn.Module):
    def __init__(
        self,
        arch: str = "Segformer",
        encoder_name: str = "resnet50",
        in_channels: int = 3,
        classes: int = 2,
    ):
        super().__init__()

        self.model = smp.create_model(
            arch=arch,
            encoder_name=encoder_name,
            encoder_weights=None,
            in_channels=in_channels,
            classes=classes,
            activation=None,
        )

    def pad_to_multiple(self, x, multiple: int = 32):
        h, w = x.shape[-2:]

        pad_h = (multiple - h % multiple) % multiple
        pad_w = (multiple - w % multiple) % multiple

        x_padded = F.pad(
            x,
            (0, pad_w, 0, pad_h),
            mode="constant",
            value=0,
        )

        return x_padded, pad_h, pad_w

    def forward(self, x):
        x_padded, pad_h, pad_w = self.pad_to_multiple(x, multiple=32)

        logits = self.model(x_padded)

        h, w = x.shape[-2:]
        logits = logits[..., :h, :w]

        return logits


def build_model(
    arch: str = "Segformer",
    encoder_name: str = "resnet50",
    num_classes: int = 2,
):
    return HVSegmentation(
        arch=arch,
        encoder_name=encoder_name,
        in_channels=3,
        classes=num_classes,
    )