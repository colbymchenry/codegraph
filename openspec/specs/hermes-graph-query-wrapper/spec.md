# hermes-graph-query-wrapper Specification

## Purpose

The Hermes graph query wrapper lets Hermes users ask natural-language questions about an indexed project and receive graph-backed answers without manually choosing low-level CodeGraph tools.

## Requirements

### Requirement: Hermes graph questions are routed through CodeGraph
The system SHALL provide a Hermes-facing query workflow that accepts a natural-language codebase question and routes it through CodeGraph-backed search, context, node, trace, callers, callees, impact, or files operations as appropriate.

#### Scenario: Natural-language architecture question
- **WHEN** a Hermes user asks how a feature or symbol works in an indexed project
- **THEN** the wrapper SHALL use CodeGraph data rather than relying only on raw file reads

#### Scenario: Caller or impact question
- **WHEN** a Hermes user asks what calls a symbol or what would be affected by changing it
- **THEN** the wrapper SHALL prefer CodeGraph caller, callee, trace, or impact functionality over unstructured text search

### Requirement: Project path handling is explicit and recoverable
The system SHALL resolve the target CodeGraph project from the active working directory when possible and SHALL provide an actionable recovery path when Hermes is running outside the indexed repository.

#### Scenario: Hermes starts outside the project
- **WHEN** the wrapper cannot find a default CodeGraph project for the current session
- **THEN** it SHALL instruct the user or agent to retry with an absolute `projectPath` for the intended repository

#### Scenario: User supplies a project path
- **WHEN** the user or agent provides an absolute project path
- **THEN** the wrapper SHALL pass that project path to CodeGraph operations and use the corresponding index

### Requirement: Answers preserve CodeGraph operational notices
The system SHALL preserve CodeGraph staleness, worktree mismatch, and not-initialized notices in wrapper output so users can tell whether graph results may be incomplete or stale.

#### Scenario: Index may be stale
- **WHEN** CodeGraph reports pending changes, catch-up status, or stale indexed data
- **THEN** the wrapper SHALL surface that notice with the answer instead of hiding it

#### Scenario: Worktree mismatch is detected
- **WHEN** CodeGraph reports that the request path and resolved index belong to different worktrees
- **THEN** the wrapper SHALL include the warning and the recommended corrective action

### Requirement: Wrapper output is concise and source-oriented
The system SHALL return concise answers that cite the CodeGraph nodes, files, or source locations used to answer the question.

#### Scenario: Answer references code behavior
- **WHEN** the wrapper explains a symbol, flow, or architectural relationship
- **THEN** it SHALL include the relevant files, symbols, or source locations available from CodeGraph output

#### Scenario: Graph result is insufficient
- **WHEN** CodeGraph results are empty or insufficient for the question
- **THEN** the wrapper SHALL say what was missing and recommend a narrower query, re-index, or raw code inspection rather than inventing an answer
