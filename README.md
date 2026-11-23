# APCore Surfaces

Toolkit and the MCP, A2A, and CLI integrations for the [APCore runtime](https://github.com/aiperceivable/apcore). Each component maintains Python, Rust, and TypeScript implementations and publishes them separately.

[Browse the APCore Surfaces documentation](https://aiperceivable.github.io/apcore-surfaces/).

| Component | Published package | Documentation | Shared conformance |
| --- | --- | --- | --- |
| Toolkit | `apcore-toolkit` | [Toolkit](https://aiperceivable.github.io/apcore-surfaces/toolkit/) | [Fixtures](toolkit/conformance/) |
| MCP | `apcore-mcp` | [MCP](https://aiperceivable.github.io/apcore-surfaces/mcp/) | [Fixtures](mcp/conformance/) |
| A2A | `apcore-a2a` | [A2A](https://aiperceivable.github.io/apcore-surfaces/a2a/) | [Fixtures](a2a/conformance/) |
| CLI | `apcore-cli` | [CLI](https://aiperceivable.github.io/apcore-surfaces/cli/) | [Fixtures](cli/conformance/) |

Build from the component's language directory. Published manifests use normal registry dependencies. CI verifies the toolkit from the same checkout in the three language test matrices, then checks independent distribution builds with registry resolution.

For release history from before consolidation, see [the source repository index](migration/sources.tsv). Each original repository retains its own tags and release notes.
