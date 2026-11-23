import math
import struct


def _float32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


def canonical_display(source: dict) -> dict:
    display = dict(source)
    if "tonemap" in display and "toneMapping" not in display:
        name = display.pop("tonemap")
        display["toneMapping"] = "linear" if name == "none" else name
    stops = display.get("exposure")
    # Stop-space interpolation is nonlinear in linear units. Preserve legacy tracks.
    if "toneMappingExposure" not in display and type(stops) in (int, float):
        try:
            exposure = _float32(2 ** _float32(stops))
        except OverflowError:
            return display
        if math.isfinite(exposure) and exposure > 0:
            display["toneMappingExposure"] = exposure
            del display["exposure"]
    return display


def canonical_settings(settings):
    if isinstance(settings, dict) and isinstance(settings.get("display"), dict):
        return {**settings, "display": canonical_display(settings["display"])}
    return settings
