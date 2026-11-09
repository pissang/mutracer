#!/usr/bin/env python3
# Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
"""Package a Blender-specific CMake install tree as a legacy add-on zip."""
import argparse
from pathlib import Path
import shutil
import tempfile
import zipfile


def check_archive(path):
    with zipfile.ZipFile(path) as archive:
        invalid = [name for name in archive.namelist()
                   if any(part == "__MACOSX" or part.startswith("._")
                          for part in name.replace("\\", "/").split("/"))]
        if invalid:
            raise ValueError(f"AppleDouble metadata in archive: {invalid}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plugin", type=Path, help="Installed directory containing hdMuTracer/")
    parser.add_argument("output", type=Path, help="Output zip (outside the repository)")
    args = parser.parse_args()
    integration = Path(__file__).resolve().parent
    root = integration.parents[2]
    for name in ("libhdMuTracer.dylib", "libmutracer.dylib", "resources/plugInfo.json"):
        if not (args.plugin / "hdMuTracer" / name).is_file():
            parser.error(f"Missing Blender build artifact: {name}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mutracer-blender-") as directory:
        package = Path(directory) / "mutracer_blender"
        shutil.copytree(integration / "mutracer_blender", package, ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(args.plugin / "hdMuTracer", package / "plugin" / "hdMuTracer")
        shutil.copy(root / "LICENSE", package / "LICENSE")
        shutil.copy(root / "THIRD_PARTY_NOTICES.md", package / "THIRD_PARTY_NOTICES.md")
        shutil.copytree(root / "LICENSES", package / "LICENSES")
        with zipfile.ZipFile(args.output, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(package.rglob("*")):
                if any(part == "__MACOSX" or part.startswith("._")
                       for part in path.relative_to(directory).parts):
                    continue
                if path.is_file() and not path.name.startswith("."):
                    archive.write(path, path.relative_to(directory))
    check_archive(args.output)
    print(args.output)


if __name__ == "__main__":
    main()
