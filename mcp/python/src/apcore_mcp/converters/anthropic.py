"""Project APCore module descriptors into Anthropic Messages tools."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from apcore_mcp.adapters.id_normalizer import ModuleIDNormalizer
from apcore_mcp.adapters.schema import apply_llm_descriptions, strip_schema_extensions


class AnthropicConverter:
    """Convert one module descriptor to an Anthropic Messages tool."""

    def __init__(self) -> None:
        self._names = ModuleIDNormalizer()

    def convert_descriptor(self, descriptor: Any) -> dict[str, Any]:
        """Preserve input constraints and expose descriptor input examples."""
        schema = deepcopy(descriptor.input_schema)
        apply_llm_descriptions(schema)
        strip_schema_extensions(schema)
        tool = {
            "name": self._names.normalize(descriptor.module_id),
            "description": descriptor.description,
            "input_schema": schema,
        }
        examples = getattr(descriptor, "examples", None)
        if examples:
            tool["input_examples"] = [deepcopy(example.inputs) for example in examples]
        return tool
