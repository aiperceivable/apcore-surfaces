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
from shutil import copyfile


def package_name(manifest: Path) -> str:
    return tomllib.loads(manifest.read_text())["package"]["name"]


def pin_core(manifest: Path, version: str, *, macros: bool = False) -> None:
    original = manifest.read_text()
    dependency = tomllib.loads(original)["dependencies"]["apcore"]
    if isinstance(dependency, str):
        pattern = r'^(apcore\s*=\s*")[^"]+(")$'
    else:
        pattern = r'^(apcore\s*=\s*\{[^\n}]*\bversion\s*=\s*")[^"]+("[^\n}]*\})$'
    text, count = re.subn(
        pattern,
        lambda match: f"{match[1]}={version}{match[2]}",
        original,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise ValueError(f"Expected a versioned apcore dependency in {manifest}")
    if macros:
        text, count = re.subn(
            r'^(apcore\s*=\s*\{[^\n}]*\bfeatures\s*=\s*\[[^\n\]]+)(\][^\n}]*\})$',
            lambda match: f'{match[1]}, "macros"{match[2]}',
            text,
            count=1,
            flags=re.MULTILINE,
        )
        if count != 1:
            raise ValueError(f"Expected declared apcore features in {manifest}")
    manifest.write_text(text)


def verify(
    component: str,
    version: str,
    archive: Path | None,
    macro_archive: Path | None,
    typed_example: Path | None,
) -> None:
    repo = Path(__file__).resolve().parents[1]
    manifest = repo / component / "rust" / "Cargo.toml"
    toolkit = repo / "toolkit" / "rust" / "Cargo.toml"
    manifests = {manifest: manifest.read_bytes(), toolkit: toolkit.read_bytes()}
    lock = manifest.with_name("Cargo.lock")
    lock_contents = lock.read_bytes() if lock.exists() else None
    test = manifest.parent / "tests" / "candidate_typed_module.rs"
    if typed_example is not None and (component != "mcp" or macro_archive is None or test.exists()):
        raise ValueError("A typed example requires an MCP checkout and a macro archive")
    try:
        if typed_example is not None:
            copyfile(typed_example, test)
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

            expected_macro = None
            if macro_archive is not None:
                if archive is None:
                    raise ValueError("A candidate macro archive requires a candidate Core archive")
                print(f"Macro crate SHA-256 {hashlib.sha256(macro_archive.read_bytes()).hexdigest()}", flush=True)
                with tarfile.open(macro_archive, "r:gz") as crate:
                    crate.extractall(temp, filter="data")
                expected_macro = Path(temp) / f"apcore-macros-{version}" / "Cargo.toml"
                if package_name(expected_macro) != "apcore-macros":
                    raise ValueError("Candidate archive does not contain the apcore-macros package")
                patches += ["--config", f"patch.crates-io.apcore-macros.path={json.dumps(str(expected_macro.parent))}"]

            # Stable Cargo ranges exclude pre-releases. Pin the tested component
            # and the checkout Toolkit together so both share one Core type identity.
            for path in manifests:
                pin_core(path, version, macros=path == manifest and typed_example is not None)

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
            if typed_example is not None:
                macros = [p for p in info["packages"] if p["name"] == "apcore-macros"]
                if len(macros) != 1 or Path(macros[0]["manifest_path"]).resolve() != expected_macro.resolve():
                    raise ValueError("Consumer did not resolve the verified candidate macro archive")
            toolkits = [p for p in info["packages"] if p["name"] == "apcore-toolkit"]
            if len(toolkits) != 1 or Path(toolkits[0]["manifest_path"]).resolve() != toolkit:
                raise ValueError("Consumer did not resolve the Toolkit from this checkout")
            print(f"Resolved apcore {version} at {core['manifest_path']}", flush=True)
            print(f"Resolved apcore-toolkit {toolkits[0]['version']} at {toolkit}", flush=True)
            subprocess.run([*command, "test", "--all-features", "--locked"], cwd=manifest.parent, check=True)
    finally:
        if typed_example is not None:
            test.unlink(missing_ok=True)
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
    parser.add_argument("--macro-archive", type=Path)
    parser.add_argument("--typed-example", type=Path)
    options = parser.parse_args()
    verify(options.component, options.version, options.archive, options.macro_archive, options.typed_example)
