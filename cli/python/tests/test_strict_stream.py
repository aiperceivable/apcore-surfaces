"""JSONL, diagnostics and audit with a real completion-capable Executor."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import click
import pytest
from apcore import Context, Executor, ModuleAnnotations, ModuleExecuteError, Registry
from apcore.middleware import Middleware
from click.testing import CliRunner
from pydantic import BaseModel

from apcore_cli.cli import build_module_command
from apcore_cli.discovery import register_exec_command
from apcore_cli.exit_codes import EXIT_INVALID_INPUT, EXIT_SCHEMA_VALIDATION_ERROR
from apcore_cli.security.audit import AuditLogger, get_audit_logger, set_audit_logger

_HAS_COMPLETION = callable(getattr(Executor, "stream_with_completion", None))


class _Input(BaseModel):
    pass


class _Output(BaseModel):
    value: int


class _Module:
    annotations = ModuleAnnotations(streaming=True)
    description = "Return two partial outputs"
    input_schema = _Input
    output_schema = _Output

    def __init__(self, last_value: object) -> None:
        self.last_value = last_value
        self.entries = 0

    async def execute(self, inputs: dict[str, Any], context: Context) -> dict[str, Any]:
        self.entries += 1
        return {"value": self.last_value}

    async def stream(self, inputs: dict[str, Any], context: Context) -> AsyncIterator[dict[str, Any]]:
        self.entries += 1
        yield {"value": 1}
        yield {"value": self.last_value}


@pytest.fixture
def audit_log(tmp_path: Path) -> Iterator[Path]:
    file = tmp_path / "audit.jsonl"
    previous = get_audit_logger()
    set_audit_logger(AuditLogger(file))
    try:
        yield file
    finally:
        set_audit_logger(previous)


def _setup(
    module: _Module, *, generic: bool = False, legacy: bool = False, middleware: Middleware | None = None
) -> tuple[click.Command, list[str]]:
    class LegacyExecutor(Executor):
        stream_with_completion = None  # type: ignore[assignment]

    registry = Registry()
    registry.register("test.stream", module)
    executor = LegacyExecutor(registry) if legacy else Executor(registry)
    if middleware is not None:
        executor.use(middleware)
    if generic:
        group = click.Group("apcli")
        register_exec_command(group, registry, executor)
        return group, ["exec", "test.stream", "--input", "{}"]
    descriptor = registry.get_definition("test.stream")
    assert descriptor is not None
    return build_module_command(descriptor, executor), []


@pytest.mark.parametrize("generic", [False, True])
@pytest.mark.parametrize("value", [2, "not an integer"])
@pytest.mark.skipif(not _HAS_COMPLETION, reason="run with the A2 wheel for the completion path")
def test_strict_jsonl_exit_and_audit_follow_completion(audit_log: Path, generic: bool, value: object) -> None:
    module = _Module(value)
    cli, args = _setup(module, generic=generic)
    result = CliRunner().invoke(cli, [*args, "--strict-stream"])
    assert [json.loads(line) for line in result.stdout.splitlines()] == [{"value": 1}, {"value": value}]
    records = [json.loads(line) for line in audit_log.read_text().splitlines()]
    assert len(records) == 1
    if value == 2:
        assert result.exit_code == 0, result.output
        assert records[0]["status"] == "success"
        assert result.stderr == ""
    else:
        assert result.exit_code == EXIT_SCHEMA_VALIDATION_ERROR, result.output
        assert records[0]["status"] == "error"
        assert "validation" in result.stderr.lower()
    assert records[0]["exit_code"] == result.exit_code
    assert module.entries == 1


@pytest.mark.parametrize("generic", [False, True])
def test_old_core_refuses_strict_before_invocation(generic: bool) -> None:
    module = _Module(2)
    cli, args = _setup(module, generic=generic, legacy=True)
    result = CliRunner().invoke(cli, [*args, "--strict-stream"])
    assert result.exit_code == EXIT_INVALID_INPUT
    assert "completion" in result.stderr
    assert result.stdout == ""
    assert module.entries == 0


def test_legacy_stream_preserves_emitted_lines_and_old_terminal_behavior(audit_log: Path) -> None:
    module = _Module("not an integer")
    cli, args = _setup(module)
    result = CliRunner().invoke(cli, [*args, "--stream"])
    assert result.exit_code == 0, result.output
    assert [json.loads(line) for line in result.stdout.splitlines()] == [{"value": 1}, {"value": "not an integer"}]
    assert json.loads(audit_log.read_text())["status"] == "success"
    assert module.entries == 1


@pytest.mark.parametrize("unsupported", [["--sandbox"], ["--trace"], ["--strategy", "standard"]])
def test_strict_rejects_modes_without_completion_before_execution(unsupported: list[str]) -> None:
    module = _Module(2)
    cli, args = _setup(module)
    result = CliRunner().invoke(cli, [*args, "--strict-stream", *unsupported])
    assert result.exit_code == EXIT_INVALID_INPUT
    assert "cannot be combined" in result.stderr
    assert module.entries == 0


@pytest.mark.skipif(not _HAS_COMPLETION, reason="run with the A2 wheel for the completion path")
def test_after_hook_failure_preserves_chunks_but_records_audit_error(audit_log: Path) -> None:
    class FailingAfter(Middleware):
        def after(self, module_id: str, inputs: dict[str, Any], output: dict[str, Any], context: Context) -> None:
            raise ModuleExecuteError(module_id, "private diagnostic")

    module = _Module(2)
    cli, args = _setup(module, middleware=FailingAfter())
    result = CliRunner().invoke(cli, [*args, "--strict-stream"])
    assert result.exit_code == 1, result.output
    assert [json.loads(line) for line in result.stdout.splitlines()] == [{"value": 1}, {"value": 2}]
    assert "after-middleware" in result.stderr
    assert json.loads(audit_log.read_text())["status"] == "error"
    assert module.entries == 1
