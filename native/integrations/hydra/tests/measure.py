#!/usr/bin/env python3
"""Compare CPU/GPU viewport output after identical warmup and camera edits."""
# Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess


def median(values):
    return statistics.median(values) if values else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--samples", type=int, default=64)
    parser.add_argument("--fps", type=int, nargs="+", default=[0, 30])
    args = parser.parse_args()
    build, output = args.build.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    scene = Path(__file__).with_name("rect.usda").resolve()
    rows = []
    for width, height in [(1280, 720), (1920, 1080), (3840, 2160)]:
        for fps in args.fps:
            for cpu in [1, 0]:
                prefix = output / f"{width}x{height}-{fps}fps-{'cpu' if cpu else 'gpu'}"
                env = dict(os.environ, PXR_PLUGINPATH_NAME=str(build / "plugin/hdMuTracer/resources"),
                           MUTRACER_HYDRA_BENCH="1", MUTRACER_HYDRA_TIMELINE="1",
                           MUTRACER_HYDRA_CPU=str(cpu), MUTRACER_HYDRA_BACKEND="1",
                           MUTRACER_HYDRA_FPS=str(fps), MUTRACER_HYDRA_TRACE=str(prefix) + ".jsonl")
                with open(str(prefix) + ".log", "w") as log:
                    subprocess.run([str(build / "hydraTrace"), str(scene), str(prefix),
                                    "HdMuTracerRendererPlugin", str(width), str(height), str(args.samples)],
                                   env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180, check=True)
                phases = [json.loads(x) for x in Path(str(prefix) + "-summary.jsonl").read_text().splitlines()]
                steady = phases[-1]
                records = [json.loads(x) for x in Path(str(prefix) + ".jsonl").read_text().splitlines()]
                records = records[-steady["frames"]:]
                if any(x["gpuOutput"] != (not cpu) for x in records):
                    raise RuntimeError(f"unexpected output fallback: {prefix}")
                events = json.loads(Path(str(prefix) + "-timeline.json").read_text())["traceEvents"]
                aov = [x["dur"] / 1000 for x in events if x["ph"] == "X" and
                       x["name"].endswith("HdxAovInputTask::Execute")][-steady["frames"]:]
                uploads = [x["dur"] / 1000 for x in events if x["ph"] == "X" and
                           x["name"].endswith("HdxAovInputTask::_UpdateTexture")]
                # Color/depth uploads occur twice per CPU host frame. The GPU
                # output path should bypass them, including its first frame.
                row = dict(width=width, height=height, fps=fps, cpu=bool(cpu), **steady)
                row["hgiAovInputP50Ms"] = median(aov)
                row["hgiUploadCalls"] = len(uploads)
                row["hgiUploadP50Ms"] = median(uploads[-steady["frames"] * 2:])
                for name in ["exportMs", "convertMs", "readHdrMs", "readDepthMs", "readIdMs", "readMs"]:
                    values = [x[name] for x in records if x[name] > 0]
                    row[name] = median(values)
                    row[name + "Calls"] = len(values)
                row["actualBackend"] = sorted(set(x["renderBackend"] for x in records if x["samples"]))
                rows.append(row)
                (output / "summary.json").write_text(json.dumps(rows, indent=2) + "\n")
                print(json.dumps(row), flush=True)


if __name__ == "__main__":
    main()
