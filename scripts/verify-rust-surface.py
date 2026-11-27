"""Run ordinary Rust CI against pinned local prerelease inputs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tarfile
import tempfile
import tomllib
from pathlib import Path


def verify(component: str, mode: str, core: Path) -> None:
    repo = Path(__file__).resolve().parents[1]
    core = core.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="surface-rust-ci-") as temporary:
        scratch = Path(temporary).resolve()
        # Cargo path patches replace two registry entries in the lock. Keep
        # that lock in a disposable snapshot, including for crate packaging.
        archive = scratch / "source.tar"
        subprocess.run(["git", "archive", "--output", archive, "HEAD"], cwd=repo, check=True)
        with tarfile.open(archive) as source:
            source.extractall(scratch, filter="data")
        archive.unlink()

        crate = scratch / component / "rust"
        toolkit = scratch / "toolkit" / "rust"
        expected = {"apcore": core, "apcore-toolkit": toolkit}
        patches = ["--config", f"patch.crates-io.apcore.path={json.dumps(core.as_posix())}"]
        if component != "toolkit":
            patches += ["--config", f"patch.crates-io.apcore-toolkit.path={json.dumps(toolkit.as_posix())}"]

        env = os.environ.copy()
        env.setdefault("CARGO_TARGET_DIR", str(repo / component / "rust" / "target"))
        host = next(
            line.removeprefix("host: ")
            for line in subprocess.check_output(["rustc", "-vV"], text=True, env=env).splitlines()
            if line.startswith("host: ")
        )
        lockfile = crate / "Cargo.lock"
        locked = tomllib.loads(lockfile.read_text(encoding="utf-8"))["package"]
        metadata = json.loads(subprocess.check_output(
            ["cargo", "metadata", *patches, "--all-features", "--format-version", "1", "--filter-platform", host],
            cwd=crate,
            env=env,
        ))
        for name, path in expected.items():
            versions = [entry["version"] for entry in locked if entry["name"] == name]
            matches = [entry for entry in metadata["packages"] if entry["name"] == name]
            if (
                len(versions) != 1
                or len(matches) != 1
                or matches[0]["version"] != versions[0]
                or Path(matches[0]["manifest_path"]).resolve() != path / "Cargo.toml"
            ):
                raise ValueError(f"Expected one locked {name} version {versions!r} at {path}")
            print(f"Resolved {name} {versions[0]} at {matches[0]['manifest_path']}", flush=True)

        # The path substitution must not advance or otherwise change any
        # locked dependencies. Only the local source identifiers disappear.
        for entry in locked:
            if entry["name"] in expected:
                entry.pop("source", None)
                entry.pop("checksum", None)
        if tomllib.loads(lockfile.read_text(encoding="utf-8"))["package"] != locked:
            raise ValueError("Cargo changed the locked dependency graph while applying the prerelease inputs")

        if mode == "package":
            subprocess.run(["cargo", "package", *patches, "--locked"], cwd=crate, env=env, check=True)
            return
        commands = [
            ["clippy", "--locked", "--all-targets", "--all-features", "--", "-D", "warnings"],
            ["test", "--locked", "--all-features"],
        ]
        if component != "toolkit":
            commands.append(["build", "--locked", "--examples"])
        if component in {"toolkit", "a2a"}:
            commands.append(["check", "--locked", "--no-default-features"])
        for subcommand, *args in commands:
            subprocess.run(["cargo", subcommand, *patches, *args], cwd=crate, env=env, check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=["toolkit", "mcp", "a2a", "cli"])
    parser.add_argument("mode", choices=["source", "package"])
    parser.add_argument("core", type=Path)
    options = parser.parse_args()
    verify(options.component, options.mode, options.core)
