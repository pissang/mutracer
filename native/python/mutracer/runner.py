from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Callable


class RenderError(subprocess.CalledProcessError):
    """A failed CLI call with its exit code and stderr."""

    def __str__(self):
        return f"{super().__str__()}\n{self.stderr.strip()}"


def binary() -> str:
    """Find the native binary through MUTRACER_BIN, the wheel, or PATH."""
    if value := os.environ.get("MUTRACER_BIN"):
        return value
    name = "mutracer.exe" if os.name == "nt" else "mutracer"
    packaged = Path(__file__).with_name("bin") / name
    if packaged.is_file():
        return str(packaged)
    if installed := shutil.which(name):
        return installed
    raise FileNotFoundError("MuTracer binary missing. Set MUTRACER_BIN to the native executable.")


def invoke(command: str, shot: Path, output: Path | None = None,
           progress: Callable[[dict], None] | None = None, **options) -> list[dict]:
    args = [binary(), command, str(shot)]
    if output is not None:
        args.extend(("-o", str(output)))
    for key, value in options.items():
        if value is None:
            continue
        if key == "size" and not isinstance(value, str):
            value = "x".join(map(str, value))
        if key == "frames" and not isinstance(value, str):
            value = "-".join(map(str, value))
        args.extend(("--" + key.replace("_", "-"), str(value)))

    events = []
    # A file keeps stderr draining even while stdout is read line by line.
    with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as stderr:
        with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=stderr, text=True, encoding="utf-8") as proc:
            try:
                for line in proc.stdout:
                    event = json.loads(line)
                    events.append(event)
                    if progress:
                        progress(event)
            except BaseException:
                proc.terminate()
                raise
            status = proc.wait()
        if status:
            stderr.seek(0)
            raise RenderError(status, args, stderr=stderr.read())
    return events
