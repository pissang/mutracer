"""Build local CLI distributions from a target-native binary and Node bundle."""
from __future__ import annotations

import argparse
import base64
import csv
from hashlib import sha256
from io import BytesIO, StringIO
import json
from pathlib import Path
import subprocess
import tarfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PLATFORMS = {
    "darwin-arm64": ("darwin", "arm64", "macosx_14_0_arm64", "aarch64-apple-darwin"),
    "linux-x64": ("linux", "x64", "linux_x86_64", "x86_64-unknown-linux-gnu"),
    "win32-x64": ("win32", "x64", "win_amd64", "x86_64-pc-windows-msvc"),
}
NPM = "@meimu/mutracer-cli"


def native_platform(data):
    if data[:4] == b"\xcf\xfa\xed\xfe" and int.from_bytes(data[4:8], "little") == 0x0100000C:
        return "darwin-arm64"
    if data[:6] == b"\x7fELF\x02\x01" and int.from_bytes(data[18:20], "little") == 62:
        return "linux-x64"
    if data[:2] == b"MZ":
        offset = int.from_bytes(data[0x3C:0x40], "little")
        if data[offset:offset+6] == b"PE\x00\x00\x64\x86":
            return "win32-x64"
    raise ValueError("Expected a 64-bit macOS arm64, Linux x64 or Windows x64 executable.")


def licenses(target):
    files = {"LICENSE": (ROOT / "LICENSE").read_bytes(),
             "THIRD_PARTY_NOTICES.md": (ROOT / "THIRD_PARTY_NOTICES.md").read_bytes(),
             "NATIVE_NOTICES.md": (ROOT / "native" / "THIRD_PARTY_NOTICES.md").read_bytes()}
    for folder in ("LICENSES", "native/LICENSES"):
        for path in (ROOT / folder).iterdir():
            if path.is_file():
                files[f"{folder.replace('/', '-')}/{path.name}"] = path.read_bytes()
    metadata = subprocess.check_output([
        "cargo", "metadata", "--format-version", "1", "--locked", "--filter-platform", target,
        "--manifest-path", str(ROOT / "native" / "cli" / "Cargo.toml")
    ], text=True)
    for dep in json.loads(metadata)["packages"]:
        if dep["source"] is None:
            continue
        directory = Path(dep["manifest_path"]).parent
        names = {p for p in directory.iterdir()
                 if p.is_file() and p.name.upper().startswith(("LICENSE", "COPYING", "NOTICE", "UNLICENSE"))}
        if dep["license_file"]:
            names.add(directory / dep["license_file"])
        if not names and dep["license"]:
            base=f"cargo-licenses/{dep['name']}-{dep['version']}"
            files[f"{base}/LICENSE-DECLARATION.txt"] = (dep["license"] + "\n").encode()
        for path in sorted(names):
            files[f"cargo-licenses/{dep['name']}-{dep['version']}/{path.name}"] = path.read_bytes()
    return files


def tar(path, files):
    with tarfile.open(path, "w:gz") as archive:
        for name, (data, mode) in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.mode, info.size = mode, len(data)
            archive.addfile(info, BytesIO(data))


def zip_files(path, files):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, (data, mode) in sorted(files.items()):
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (0o100000 | mode) << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)


def encoded(obj):
    return (json.dumps(obj, indent=2) + "\n").encode()


def wheel(path, binary, exe, version, tag, license_files):
    meta = f"mutracer-{version}.dist-info"
    files = {f"mutracer/{item.name}": (item.read_bytes(), 0o644)
             for item in (ROOT / "native" / "python" / "mutracer").glob("*.py")}
    files[f"mutracer/bin/{exe}"] = (binary, 0o755)
    for name, data in license_files.items():
        files[f"{meta}/licenses/{name}"] = (data, 0o644)
    metadata = f"""Metadata-Version: 2.1
Name: mutracer
Version: {version}
Summary: Author and render native MuTracer shots
Requires-Python: >=3.10
License: MIT
Provides-Extra: numpy
Requires-Dist: numpy; extra == "numpy"
Provides-Extra: usd
Requires-Dist: usd-core; extra == "usd"
Description-Content-Type: text/markdown

"""
    readme = (ROOT / "native" / "python" / "README.md").read_bytes()
    files[f"{meta}/METADATA"] = (metadata.encode() + readme, 0o644)
    files[f"{meta}/WHEEL"] = (f"Wheel-Version: 1.0\nGenerator: mutracer-pack\nRoot-Is-Purelib: false\nTag: {tag}\n".encode(), 0o644)
    files[f"{meta}/entry_points.txt"] = (b"[console_scripts]\nmutracer = mutracer.runner:main\n", 0o644)
    report = StringIO(newline="")
    csv_out = csv.writer(report)
    for name, (payload, _) in sorted(files.items()):
        digest = base64.urlsafe_b64encode(sha256(payload).digest()).decode().rstrip("=")
        csv_out.writerow((name, f"sha256={digest}", len(payload)))
    csv_out.writerow((f"{meta}/RECORD", "", ""))
    files[f"{meta}/RECORD"] = (report.getvalue().encode(), 0o644)
    zip_files(path, files)


def npm(out, binary, exe, version, platform, os_name, arch, bundle, license_files):
    native_manifest = {"name": f"{NPM}-{platform}", "version": version, "private": True,
                       "description": "Native MuTracer binary", "os": [os_name],
                       "cpu": [arch], "license": "MIT",
                       "bin": {"mutracer": f"bin/{exe}"}}
    native = {f"package/{name}": (data, 0o644) for name, data in license_files.items()}
    native["package/package.json"] = (encoded(native_manifest), 0o644)
    native[f"package/bin/{exe}"] = (binary, 0o755)
    tar(out / f"meimu-mutracer-cli-{platform}-{version}.tgz", native)

    source = ROOT / "cli"
    wrapper = json.loads((source / "package.json").read_text())
    wrapper.pop("scripts", None)
    wrapper.pop("devDependencies", None)
    wrapper["optionalDependencies"] = {f"{NPM}-{item}": version for item in PLATFORMS}
    wrapper["license"] = "MIT"
    files = {f"package/{name}": (data, 0o644) for name, data in license_files.items()}
    files["package/package.json"] = (encoded(wrapper), 0o644)
    files["package/dist/main.mjs"] = (bundle.read_bytes(), 0o755)
    files["package/src/worker.mjs"] = ((source / "src" / "worker.mjs").read_bytes(), 0o644)
    files["package/README.md"] = ((source / "README.md").read_bytes(), 0o644)
    for item in (source / "examples").iterdir():
        if item.is_file():
            data = item.read_bytes()
            if item.name == "turntable.js":
                data = data.replace(b"../../examples/assets/chess.glb", b"./assets/chess.glb")
            files[f"package/examples/{item.name}"] = (data, 0o644)
    files["package/examples/assets/chess.glb"] = ((ROOT / "examples" / "assets" / "chess.glb").read_bytes(), 0o644)
    tar(out / f"meimu-mutracer-cli-{version}.tgz", files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--bundle", type=Path, default=ROOT / "cli" / "dist" / "main.mjs")
    parser.add_argument("-o", "--output", required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.read_bytes()
    platform = native_platform(binary)
    os_name, arch, wheel_platform, target = PLATFORMS[platform]
    exe = "mutracer.exe" if os_name == "win32" else "mutracer"
    license_files = licenses(target)
    name = "mutracer"
    version = tomllib.loads((ROOT / "native" / "python" / "pyproject.toml").read_text())["project"]["version"]
    if version != json.loads((ROOT / "cli" / "package.json").read_text())["version"]:
        raise ValueError("Python and npm package versions differ.")
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    tag = f"py3-none-{wheel_platform}"
    wheel(out / f"{name}-{version}-{tag}.whl", binary, exe, version, tag, license_files)
    npm(out, binary, exe, version, platform, os_name, arch, args.bundle, license_files)
    prefix=f"mutracer-cli-{version}-{platform}"
    files={f"{prefix}/{name}": (data, 0o644) for name,data in license_files.items()}
    files[f"{prefix}/{exe}"]=(binary,0o755)
    files[f"{prefix}/guide.md"]=((ROOT / "native" / "cli" / "guide.md").read_bytes(),0o644)
    files[f"{prefix}/shot-1.schema.json"]=((ROOT / "native" / "cli" / "schema" / "mutracer-shot-v1.json").read_bytes(),0o644)
    for item in (ROOT / "native" / "cli" / "examples").iterdir():
        if item.is_file():
            data=item.read_bytes()
            if item.name=="turntable.json":
                data=data.replace(b"../../../examples/assets/chess.glb",b"./assets/chess.glb")
            files[f"{prefix}/examples/{item.name}"]=(data,0o644)
    files[f"{prefix}/examples/assets/chess.glb"]=((ROOT / "examples" / "assets" / "chess.glb").read_bytes(),0o644)
    for item in (ROOT / "native" / "cli" / "skills" / "mutracer-video").glob("*.md"):
        files[f"{prefix}/skills/mutracer-video/{item.name}"]=(item.read_bytes(),0o644)
    if os_name == "win32":
        zip_files(out / f"{prefix}.zip",files)
    else:
        tar(out / f"{prefix}.tar.gz",files)
    print(json.dumps({"platform":platform,"binaryBytes":len(binary),"output":str(out)}))


if __name__ == "__main__":
    main()
