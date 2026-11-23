"""Binary stdio client. A new worker can be initialized after terminal GPU loss."""
from __future__ import annotations

from contextlib import contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile

from ._display import canonical_settings
from .runner import RenderError, binary

MAX_HEADER = 1024 * 1024
MAX_PAYLOAD = 512 * 1024 * 1024


class Session:
    """Keep one native scene live and render frames with explicit time and edits."""

    def __init__(self):
        self._id = 0
        self._stderr = tempfile.TemporaryFile()
        try:
            self._proc = subprocess.Popen([binary(), "serve", "--stdio"], stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=self._stderr)
            self.capabilities, _ = self._request("hello", protocol=1)
            if self.capabilities["protocol"] != 1:
                raise ValueError("The worker does not support protocol 1.")
        except BaseException:
            self.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        proc = getattr(self, "_proc", None)
        if proc:
            proc.stdin.close()
            proc.stdout.close()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        self._stderr.close()

    def _lost(self):
        try:
            status = self._proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            status = self._proc.wait()
        self._stderr.seek(0)
        return RenderError(status if status in (2, 3, 4) else 5, self._proc.args,
                           stderr=self._stderr.read().decode("utf-8", errors="replace"))

    def _request(self, kind, *, payload=None, progress=None, **fields):
        self._id += 1
        header = {"type": kind, "id": self._id, **fields}
        if payload is not None:
            if len(payload) > self.capabilities["maxPayloadBytes"]:
                raise ValueError("Payload exceeds the worker limit.")
            header["bytes"] = len(payload)
        line = json.dumps(header, allow_nan=False, separators=(",", ":")).encode() + b"\n"
        if len(line) > MAX_HEADER:
            raise ValueError("Request header exceeds 1 MiB.")
        try:
            self._proc.stdin.write(line)
            if payload is not None:
                self._proc.stdin.write(struct.pack("<I", len(payload)))
                self._proc.stdin.write(payload)
            self._proc.stdin.flush()
        except BrokenPipeError:
            raise self._lost() from None
        while True:
            line = self._proc.stdout.readline(MAX_HEADER + 1)
            if not line:
                raise self._lost()
            if len(line) > MAX_HEADER or not line.endswith(b"\n"):
                raise ValueError("Corrupt response header from worker.")
            message = json.loads(line)
            if message["id"] != self._id:
                raise ValueError("Response ID does not match the outstanding request.")
            if message["type"] == "progress":
                if progress:
                    progress(message)
                continue
            if message["type"] == "error":
                raise RenderError(message["code"], self._proc.args, stderr=json.dumps(message))
            data = None
            if "bytes" in message:
                prefix = self._proc.stdout.read(4)
                if len(prefix) != 4:
                    raise self._lost()
                size = struct.unpack("<I", prefix)[0]
                if size != message["bytes"] or size > MAX_PAYLOAD:
                    raise ValueError("Corrupt response length from worker.")
                data = self._proc.stdout.read(size)
                if len(data) != size:
                    raise self._lost()
            return message, data

    def scene(self, shot: dict, base_directory: str | Path = ".") -> str:
        payload = json.dumps(shot, allow_nan=False, separators=(",", ":")).encode()
        header, _ = self._request("scene", format="shot-json", payload=payload,
                                  baseDir=str(Path(base_directory).resolve()))
        return header["sceneHash"]

    def asset(self, name: str, format: str, *, path=None, data=None):
        if (path is None) == (data is None):
            raise ValueError("Specify exactly one path or byte payload.")
        fields = {"path": str(Path(path).resolve())} if path is not None else {}
        self._request("asset", name=name, format=format, payload=data, **fields)

    def edit(self, changes: dict):
        self._request("edit", changes=[{"path": path, "value": value} for path, value in changes.items()])

    def check(self, frame: int, t: float, *, settings=None, progress=None):
        """Validate effective render settings without rendering or creating a GPU device."""
        fields = {"settings": canonical_settings(settings)} if settings is not None else {}
        header, _ = self._request("check", frame=frame, t=t, progress=progress, **fields)
        return header

    def render(self, frame: int, t: float, *, settings=None, progress=None):
        fields = {"settings": canonical_settings(settings)} if settings is not None else {}
        return self._request("render", frame=frame, t=t, progress=progress, **fields)


def _atomic_bytes(path: Path, data: bytes):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
            file.close()
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


@contextmanager
def _lock(directory: Path):
    with (directory / "callback.lock").open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def render_frames(shot, base: Path, directory: Path, callback, settings, fps, progress):
    """Render callbacks through a persistent native scene, with atomic frame reuse."""
    import math

    rate = fps if fps is not None else shot["output"].get("fps", 24)
    count = math.ceil(shot["output"]["duration"] * rate)
    if not 1 <= rate <= 240 or not 1 <= count <= 100_000:
        raise ValueError("Expected 1 to 240 fps and at most 100000 frames.")
    if settings.get("format", "png") != "png":
        raise ValueError("The callback video workflow requires PNG frames.")
    directory.mkdir(parents=True, exist_ok=True)
    events = []

    def emit(event):
        events.append(event)
        if progress:
            progress(event)

    state = {}
    session = None
    manifest = directory / "callback-manifest.json"
    with _lock(directory):
        try:
            session = Session()
            identity = session.scene(shot, base)
            job = {"version": 1, "scene": identity, "fps": rate, "settings": settings}
            if "check-settings" in session.capabilities.get("capabilities", []):
                checked = session.check(count - 1, (count - 1) / rate, settings=settings, progress=emit)
                if checked.get("denoiserWeights"):
                    job["denoiserWeights"] = checked["denoiserWeights"]
            if manifest.exists():
                if json.loads(manifest.read_text(encoding="utf-8")) != job:
                    raise ValueError("Callback frame directory describes a different job.")
            elif any(directory.glob("*.png")):
                raise ValueError("Callback directory contains PNGs without a manifest.")
            else:
                _atomic_bytes(manifest, json.dumps(job, sort_keys=True).encode())

            for frame in range(count):
                t = frame / rate
                changes = callback(t, frame) or {}
                state.update(changes)
                key = sha256(json.dumps(state, allow_nan=False, sort_keys=True,
                                        separators=(",", ":")).encode()).hexdigest()
                path = directory / f"frame_{frame:06d}.png"
                record = path.with_suffix(".json")
                reusable = False
                if path.exists() and record.exists():
                    old = json.loads(record.read_text(encoding="utf-8"))
                    if old["state"] != key:
                        raise ValueError(f"Callback settings changed at frame {frame}. Use a new frame directory.")
                    reusable = old["sha256"] == sha256(path.read_bytes()).hexdigest()
                pending = changes
                for attempt in range(3):
                    try:
                        if session is None:
                            session = Session()
                            if session.scene(shot, base) != identity:
                                raise ValueError("Assets changed while restarting the render worker.")
                        if pending:
                            session.edit(pending)
                        if not reusable:
                            header, payload = session.render(frame, t, settings=settings, progress=emit)
                        break
                    except RenderError as error:
                        if error.returncode != 5 or attempt == 2:
                            raise
                        emit({"event": "retry", "frame": frame, "attempt": attempt + 1})
                        if session is not None:
                            session.close()
                        session = None
                        pending = state
                if reusable:
                    emit({"event": "reused", "frame": frame, "path": str(path)})
                    continue
                _atomic_bytes(path, payload)
                _atomic_bytes(record, json.dumps({"state": key, "sha256": sha256(payload).hexdigest()}).encode())
                emit({"event": "frame", "frame": frame, "path": str(path), "elapsedMs": header["elapsedMs"]})
        finally:
            if session:
                session.close()
    return rate, events
