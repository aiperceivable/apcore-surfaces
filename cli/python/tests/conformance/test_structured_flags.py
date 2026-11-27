"""Generated CLI options use JSON containers before invoking the Executor."""

from __future__ import annotations

import json
from copy import deepcopy
from importlib.metadata import version
from pathlib import Path
from typing import Any

import click
import pytest
from apcore import Context, Executor, Registry
from click.testing import CliRunner

from apcore_cli.cli import build_module_command
from apcore_cli.exit_codes import EXIT_SCHEMA_VALIDATION_ERROR

_FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance/fixtures/structured_flags.json").read_text(encoding="utf-8")
)


class _CaptureModule:
    description = "Capture the inputs received by the module"
    output_schema = {"type": "object"}

    def __init__(self, input_schema: dict[str, Any]) -> None:
        self.input_schema = input_schema
        self.calls: list[dict[str, Any]] = []

    def execute(self, inputs: dict[str, Any], context: Context) -> dict[str, Any]:
        self.calls.append(inputs)
        return inputs


def _command(schema: dict[str, Any]) -> tuple[click.Command, _CaptureModule]:
    module = _CaptureModule(schema)
    registry = Registry()
    registry.register("test.structured_flags", module)
    descriptor = registry.get_definition("test.structured_flags")
    assert descriptor is not None
    return build_module_command(descriptor, Executor(registry)), module


@pytest.mark.parametrize("case", _FIXTURE["test_cases"], ids=lambda case: case["id"])
def test_shared_structured_flag_contract(case: dict[str, Any]) -> None:
    command, module = _command(_FIXTURE["schema"])
    result = CliRunner().invoke(command, case["args"])
    expected = case["expected"]
    assert result.exit_code == expected["exit_code"], result.output
    assert len(module.calls) == expected["calls"]
    if expected["calls"]:
        assert module.calls == [expected["input"]]
    else:
        assert result.stderr


@pytest.mark.skipif(version("apcore") == "0.33.0", reason="Core 0.33.0 loses root references inside unions")
def test_nullable_flag_resolves_a_referenced_container_branch() -> None:
    schema = deepcopy(_FIXTURE["schema"])
    schema["$defs"] = {"labels": {"type": "array", "items": {"type": "string"}}}
    schema["properties"]["maybe_labels"]["oneOf"][0] = {"$ref": "#/$defs/labels"}
    command, module = _command(schema)

    for value in ('["choice"]', "null"):
        invoked = CliRunner().invoke(command, ["--filters", "{}", "--labels", "[]", "--maybe-labels", value])
        assert invoked.exit_code == 0, invoked.output

    assert module.calls == [
        {"filters": {}, "labels": [], "maybe_labels": ["choice"]},
        {"filters": {}, "labels": [], "maybe_labels": None},
    ]


@pytest.mark.parametrize("source", ["stdin", "file"])
def test_structured_flags_override_input_without_reparsing_it(tmp_path: Path, source: str) -> None:
    schema = deepcopy(_FIXTURE["schema"])
    schema["properties"]["labels"]["default"] = ["default"]
    command, module = _command(schema)
    inline = json.dumps({"filters": {"from_input": True}, "labels": ["inline"], "note": "[]"})
    path = tmp_path / "payload.json"
    path.write_text(inline, encoding="utf-8")
    result = CliRunner().invoke(
        command,
        ["--input", "-" if source == "stdin" else str(path), "--filters", '{"from_flag":true}'],
        input=inline if source == "stdin" else None,
    )
    assert result.exit_code == 0, result.output
    assert module.calls == [{"filters": {"from_flag": True}, "labels": ["inline"], "note": "[]"}]


def test_structured_schema_defaults_stay_native() -> None:
    schema = deepcopy(_FIXTURE["schema"])
    schema["properties"]["filters"]["default"] = {"enabled": True}
    schema["properties"]["labels"]["default"] = ["default"]
    command, module = _command(schema)
    result = CliRunner().invoke(command, [])
    assert result.exit_code == 0, result.output
    assert module.calls == [{"filters": {"enabled": True}, "labels": ["default"]}]


def test_input_strings_are_not_decoded_as_structured_flags() -> None:
    command, module = _command(_FIXTURE["schema"])
    result = CliRunner().invoke(command, ["--input", "-"], input='{"filters":"{}","labels":[]}')
    assert result.exit_code == EXIT_SCHEMA_VALIDATION_ERROR, result.output
    assert module.calls == []


def test_non_json_literals_fail_before_execution() -> None:
    command, module = _command(_FIXTURE["schema"])
    result = CliRunner().invoke(command, ["--filters", '{"value": NaN}', "--labels", "[]"])
    assert result.exit_code == EXIT_SCHEMA_VALIDATION_ERROR, result.output
    assert module.calls == []


def test_nullable_and_enum_container_flags_use_the_schema_validator() -> None:
    schema = deepcopy(_FIXTURE["schema"])
    schema["properties"]["filters"] = {"type": ["object", "null"]}
    schema["properties"]["labels"]["enum"] = [["allowed"]]
    command, module = _command(schema)
    accepted = CliRunner().invoke(command, ["--filters", "{}", "--labels", '["allowed"]'])
    nullable = CliRunner().invoke(command, ["--filters", "null", "--labels", '["allowed"]'])
    rejected = CliRunner().invoke(command, ["--filters", "{}", "--labels", '["other"]'])
    assert accepted.exit_code == 0, accepted.output
    assert nullable.exit_code == 0, nullable.output
    assert rejected.exit_code == EXIT_SCHEMA_VALIDATION_ERROR, rejected.output
    assert module.calls == [
        {"filters": {}, "labels": ["allowed"]},
        {"filters": None, "labels": ["allowed"]},
    ]
