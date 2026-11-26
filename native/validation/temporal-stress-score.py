"""Score temporal-stress captures against a common OIDN reference."""

import argparse
import gzip
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates

AREAS = {"chrome": "chrome sphere", "brass": "candlestick", "screen": "screen",
         "led": "led", "flame": "flame"}


def path(directory, index):
    return directory / f"frame-{index:04}.png"


def rgb(file):
    with Image.open(file) as image:
        return np.asarray(image.convert("RGB"), dtype=np.float32)


def rms(values):
    return float(np.sqrt(np.mean(values ** 2, dtype=np.float64))) if values.size else None


def masks(directory, index, size, capture):
    filename = directory / f"{index:04}-mask.gz"
    if filename.is_file():
        with gzip.open(filename, "rb") as data:
            labels = np.frombuffer(data.read(), "u1").reshape(size[::-1])
        return {area: labels == i for i, area in enumerate(AREAS, 1)}
    ids = np.memmap(directory / f"frame-{index:04}.id.u32", dtype="<u4",
                   mode="r", shape=(*size[::-1], 4))
    materials = capture["materials"][str(index)]
    return {area: np.isin(ids[:, :, 2], materials[name]) for area, name in AREAS.items()}


def highlight_templates(reference, cameras, size):
    width, height = size
    if not cameras:
        return
    left, right = round(500 * width / 1280), round(1150 * width / 1280)
    top, bottom = round(510 * height / 720), round(695 * height / 720)
    y, x = np.mgrid[top:bottom, left:right]
    luma = np.array([.2126, .7152, .0722])

    def pose(index):
        data = cameras[str(index)]
        right, up, back, eye = np.array(data["transform"]).reshape(4, 4)[:, :3]
        focal = height / (2 * np.tan(np.deg2rad(data["fov"]) / 2)) * data["zoom"]
        return right, up, -back, eye, focal

    def structure(image):
        return gaussian_filter(image, (.9, .9, 0)) - gaussian_filter(image, (4, 4, 0))

    # Keep the web experiment's 141–165 band and use ±8 reprojected reference taps.
    images = {i: rgb(file) for i, file in reference.items()
              if 140 <= i <= 173 and str(i) in cameras}
    for i in range(141, 166):
        if i not in images:
            continue
        right_axis, up, forward, eye, focal = pose(i)
        ray = forward + (x + .5 - width / 2)[..., None] * right_axis / focal
        ray = ray - (y + .5 - height / 2)[..., None] * up / focal
        world = eye + ray * ((.77 - eye[1]) / ray[..., 1])[..., None]
        current = structure(images[i][y, x])
        neighbor = np.zeros_like(current)
        weight = 0
        for j in range(i - 8, i + 9):
            if j == i or j not in images:
                continue
            right_axis, up, forward, eye, focal = pose(j)
            delta = world - eye
            scale = focal / (delta @ forward)
            qx, qy = width / 2 - .5 + scale * (delta @ right_axis), height / 2 - .5 - scale * (delta @ up)
            w = 1 - abs(j - i) / 9
            for c in range(3):
                neighbor[..., c] += w * map_coordinates(images[j][..., c], (qy, qx), order=1, mode="nearest")
            weight += w
        if not weight:
            continue
        direction = structure(neighbor / weight) - current
        support = ((x >= left + 6) & (x < right - 6) & (y >= top + 6) & (y < bottom - 6)
                   & (world[..., 0] > -.39) & (world[..., 0] < 1.19)
                   & (world[..., 2] > -1.04) & (world[..., 2] < -.16)
                   & (direction @ luma > 1.) & (np.abs(current @ luma) < 2.))
        yield i, np.s_[top:bottom, left:right], current, direction[support], support, structure


def score(reference, runs, mask_dir, first, last):
    capture = json.loads((mask_dir / "capture.json").read_text())
    size = tuple(capture["settings"].get("size", (1280, 720)))
    report = {"frames": {}, "reference_coverage": {}, "timing": {}}
    previous = None
    for index in range(first, last + 1):
        if not all(path(directory, index).is_file() for directory in runs.values()):
            raise ValueError(f"Run output is missing at frame {index}")
        selected = masks(mask_dir, index, size, capture)
        images = {name: rgb(path(directory, index)) for name, directory in runs.items()}
        target = reference.get(index)
        report["reference_coverage"][index] = str(target) if target else None
        rgb_target = rgb(target) if target else None
        residuals = {name: image - rgb_target for name, image in images.items()} if target else None
        row = {}
        for area, mask in selected.items():
            if not mask.any():
                continue
            area_scores = {}
            for name, image in images.items():
                data = {"rmse": rms(residuals[name][mask]) if residuals else None}
                if previous:
                    former_masks, former_images, former_residuals = previous
                    overlap = mask & former_masks[area]
                    data["frame_delta_rmse"] = rms((image - former_images[name])[overlap])
                    if residuals and former_residuals:
                        data["adjacent_error_rmse"] = rms((residuals[name] - former_residuals[name])[overlap])
                area_scores[name] = data
            row[area] = {"pixels": int(mask.sum()), "arms": area_scores}
        previous = selected, images, residuals
        report["frames"][index] = row

    totals = {name: {"dot": 0., "norm": 0., "pixels": 0, "frames": []} for name in runs}
    for i, region, current, direction, support, structure in highlight_templates(reference, capture.get("cameras"), size):
        for name, directory in runs.items():
            if not first <= i <= last:
                continue
            error = (structure(rgb(path(directory, i))[region]) - current)[support]
            result = totals[name]
            result["dot"] += float(np.sum(error * direction, dtype=np.float64))
            result["norm"] += float(np.sum(direction ** 2, dtype=np.float64))
            result["pixels"] += int(support.sum())
            result["frames"].append(i)
    for result in totals.values():
        norm, dot = result.pop("norm"), result.pop("dot")
        result["old_feature_leakage"] = dot / norm if norm else None
    report["tabletop_highlights"] = totals

    averages = {}
    for area in AREAS:
        averages[area] = {}
        for name in runs:
            averages[area][name] = {}
            for key in ("rmse", "adjacent_error_rmse", "frame_delta_rmse"):
                values = [row[area]["arms"][name].get(key) for row in report["frames"].values() if area in row]
                values = [v for v in values if v is not None]
                averages[area][name][key] = {"mean": float(np.mean(values)) if values else None, "frames": len(values)}
    report["averages"] = {f"{first}-{last}": averages}
    for name, directory in runs.items():
        metadata = json.loads((directory / "capture.json").read_text())
        timing = metadata["timing"]
        per_frame = {i: timing["renderMs"][i - metadata["first"]] for i in range(first, last + 1)}
        report["timing"][name] = {"render_and_push_ms": per_frame,
                                  "median_ms": float(np.median(list(per_frame.values()))),
                                  "planning_ms": timing.get("pilotMs", 0),
                                  "wall_seconds": metadata["seconds"]}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, action="append", required=True)
    parser.add_argument("--masks", type=Path, required=True)
    parser.add_argument("--run", nargs=2, metavar=("NAME", "DIRECTORY"), action="append", required=True)
    parser.add_argument("--frames", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    first, last = map(int, args.frames.split("-"))
    reference = {}
    for directory in args.reference:
        source = {int(file.stem.split("-")[-1]): file for file in directory.glob("frame-*.png")}
        if not source:
            parser.error(f"No reference frames in {directory}")
        reference.update(source)
    report = score(reference, {name: Path(directory) for name, directory in args.run}, args.masks, first, last)
    args.output.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
