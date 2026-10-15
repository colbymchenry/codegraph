# Architecture Checks

`codegraph architecture --root src --depth 1 --deny src/graph:src/bin --strict` checks a forbidden dependency direction. Use `--json` for the complete report and `--allow-undeclared` to include name-only matches.

The public API is `CodeGraph.getArchitectureReport(options)`. Reports include module-level cycles and bounded source evidence for each violation. Module grouping and cycle detection are shared with the viewer. Nothing is added to the persistent graph.

Unspecified roots and depths use the viewer's automatic scope. Pin both for stable CI checks. By default, only dependencies backed by declared source evidence can violate a boundary; excluded name-only matches are counted separately. Cycles use the existing file-dependency graph and can include heuristic matches.

This first contribution exposes the API and CLI. Project configuration and MCP registration can be reviewed separately. Large-repository timing and cross-platform CI are still pending.
