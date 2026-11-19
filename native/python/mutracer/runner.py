from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Callable


_RENDER_COMMANDS = {"still", "preview", "render"}


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
    managed = command in _RENDER_COMMANDS
    if managed:
        args.insert(1, "--parent-stdin")
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
        with subprocess.Popen(args, stdin=subprocess.PIPE if managed else None,
                              stdout=subprocess.PIPE, stderr=stderr, text=True, encoding="utf-8") as proc:
            try:
                for line in proc.stdout:
                    event = json.loads(line)
                    events.append(event)
                    if progress:
                        progress(event)
            except BaseException:
                if managed:
                    proc.stdin.close()
                else:
                    proc.terminate()
                raise
            status = proc.wait()
        if status:
            stderr.seek(0)
            raise RenderError(status, args, stderr=stderr.read())
    return events


def main():
    """Forward the console entry point to the platform executable."""
    import sys

    executable = binary()
    if Path(executable).resolve() == Path(sys.argv[0]).resolve():
        print("Native MuTracer binary missing. Set MUTRACER_BIN to a native executable.", file=sys.stderr)
        return 3
    environment = os.environ.copy()
    environment.setdefault("MUTRACER_PYTHON", sys.executable)
    args = [executable, *sys.argv[1:]]
    if os.name != "nt":
        os.execvpe(executable, args, environment)
    if len(args) > 1 and args[1] in _RENDER_COMMANDS:
        args.insert(1, "--parent-stdin")
        return subprocess.call(args, stdin=subprocess.PIPE, env=environment)
    return subprocess.call(args, env=environment)
