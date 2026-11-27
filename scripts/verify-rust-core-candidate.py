#!/usr/bin/env python3
"""Test a Rust Surface with one exact Core distribution in a disposable checkout."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import tarfile
import tempfile
import tomllib
from pathlib import Path


def package_name(manifest: Path) -> str:
    return tomllib.loads(manifest.read_text())["package"]["name"]


def pin_core(manifest: Path, version: str) -> None:
    text, count = re.subn(
        r'^apcore = "[^"]+"$',
        f'apcore = "={version}"',
        manifest.read_text(),
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise ValueError(f"Expected a version-only apcore dependency in {manifest}")
    manifest.write_text(text)


def verify(component: str, version: str, archive: Path | None) -> None:
    repo = Path(__file__).resolve().parents[1]
    manifest = repo / component / "rust" / "Cargo.toml"
    toolkit = repo / "toolkit" / "rust" / "Cargo.toml"
    manifests = {manifest: manifest.read_bytes(), toolkit: toolkit.read_bytes()}
    lock = manifest.with_name("Cargo.lock")
    lock_contents = lock.read_bytes() if lock.exists() else None
    try:
        with tempfile.TemporaryDirectory(prefix="surface-core-") as temp:
            patches = ["--config", f"patch.crates-io.apcore-toolkit.path={json.dumps(str(toolkit.parent))}"]
            expected_core_path = None
            if archive is not None:
                print(f"Core crate SHA-256 {hashlib.sha256(archive.read_bytes()).hexdigest()}", flush=True)
                with tarfile.open(archive, "r:gz") as crate:
                    crate.extractall(temp, filter="data")
                expected_core_path = Path(temp) / f"apcore-{version}" / "Cargo.toml"
                if package_name(expected_core_path) != "apcore":
                    raise ValueError("Candidate archive does not contain the apcore package")
                patches += ["--config", f"patch.crates-io.apcore.path={json.dumps(str(expected_core_path.parent))}"]

            # Stable Cargo ranges exclude pre-releases. Pin the tested component
            # and the checkout Toolkit together so both share one Core type identity.
            for path in manifests:
                pin_core(path, version)

            command = ["cargo", *patches]
            rust_host = next(
                line.removeprefix("host: ")
                for line in subprocess.check_output(["rustc", "-vV"], text=True).splitlines()
                if line.startswith("host: ")
            )
            info = json.loads(subprocess.check_output(
                [*command, "metadata", "--format-version", "1", "--filter-platform", rust_host],
                cwd=manifest.parent,
            ))
            cores = [p for p in info["packages"] if p["name"] == "apcore"]
            if len(cores) != 1 or cores[0]["version"] != version:
                raise ValueError(f"Expected one apcore {version}, resolved {[p['version'] for p in cores]}")
            core = cores[0]
            if expected_core_path is None:
                if not (core["source"] or "").startswith("registry+"):
                    raise ValueError("Expected the minimum Core from the registry")
            elif Path(core["manifest_path"]).resolve() != expected_core_path.resolve():
                raise ValueError("Consumer did not resolve the verified candidate archive")
            toolkits = [p for p in info["packages"] if p["name"] == "apcore-toolkit"]
            if len(toolkits) != 1 or Path(toolkits[0]["manifest_path"]).resolve() != toolkit:
                raise ValueError("Consumer did not resolve the Toolkit from this checkout")
            print(f"Resolved apcore {version} at {core['manifest_path']}", flush=True)
            print(f"Resolved apcore-toolkit {toolkits[0]['version']} at {toolkit}", flush=True)
            subprocess.run([*command, "test", "--all-features", "--locked"], cwd=manifest.parent, check=True)
    finally:
        for path, data in manifests.items():
            path.write_bytes(data)
        if lock_contents is None:
            lock.unlink(missing_ok=True)
        else:
            lock.write_bytes(lock_contents)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=["toolkit", "mcp", "a2a", "cli"])
    parser.add_argument("version")
    parser.add_argument("--archive", type=Path)
    options = parser.parse_args()
    verify(options.component, options.version, options.archive)
