# Documentation

To install and use CodeGraph, start with the [project README](../README.md). To build it and send a change, see [Contributing](../CONTRIBUTING.md).

## Guides

| Topic | Where to start |
|-------|----------------|
| Architecture, build rules and platform validation | [Project guide](../AGENTS.md) |
| Distribution and release packaging | [Bundling](../BUNDLING.md) |
| What telemetry collects, and how to turn it off | [Telemetry](../TELEMETRY.md) |
| Release history | [Changelog](../CHANGELOG.md) |
| Entries held for the viewer's launch | [Viewer changelog](viewer-launch-changelog.md) |
| What languages and frameworks cover, and what's left | [Framework coverage](design/framework-coverage.md) |
| Validating a language or framework on real repositories | [Validation guide](AGENTS.md) and [coverage playbook](design/dynamic-dispatch-coverage-playbook.md) |
| Checking a language by hand | [Language verification guide](SEARCH_QUALITY_LOOP.md) |
| The browser viewer's design | [Viewer design spec](design/codegraph-ui-design-spec.md) |
| The native extraction kernel | [Kernel design](design/native-extraction-kernel.md) |

## Supporting material

- [Design](design/): architecture notes and feature proposals. Some describe planned work rather than what has shipped.
- [Benchmarks](benchmarks/): measurements and how they were taken. Read each against the revision and setup it records.
- [Grammars](grammars/): notes and patches for the parser grammars CodeGraph builds itself.
- [Plans](plans/): implementation plans.
- [Discussion notes](from-chat/): supporting notes from design discussions.
