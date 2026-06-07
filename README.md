# openclaw-multi-session-plugins

OpenClaw plugin for per-session workspace isolation and scoped XWorkmate artifact handling.

## Why

XWorkmate talks to OpenClaw through `xworkmate-bridge` using the app-facing
`/acp` and `/acp/rpc` contract with OpenClaw routing metadata. The bridge sends
`chat.send`, waits for `agent.wait`, then asks this plugin for a session/run-scoped artifact manifest.
The app can then sync generated files into its local thread workspace without
changing the UI or adding provider-specific routes.

This plugin is not a scheduler or bridge client. OpenClaw core owns sub-agents,
multi-agent routing, queues, cron, task registry state, and cross-session
execution. This package only adapts existing OpenClaw task and session
identities into isolated artifact directories, durable session key mappings,
and signed artifact reads.

In practice, it provides:

- session preparation for a specific app thread and run
- task-scoped artifact directories under the resolved OpenClaw workspace
- safe export and read operations for XWorkmate Bridge
- signed artifact references that are bound to the issuing session and run

It registers the minimal Gateway methods needed by XWorkmate:

```text
xworkmate.session.prepare
xworkmate.tasks.get
xworkmate.artifacts.collect-and-snapshot
xworkmate.artifacts.export
xworkmate.artifacts.read
```

`xworkmate.session.prepare` writes the durable
`SessionEntry.pluginExtensions["openclaw-multi-session-plugins"]["xworkmate.sessionMapping"]`
mapping and creates a per-task artifact scope under `tasks/` in the resolved
OpenClaw workspace. `export` and `read` then return safe, relative artifact
entries that XWorkmate Bridge can normalize into the APP `artifacts[]` contract.

## Install

Install from the npm package through OpenClaw:

```bash
openclaw plugins install openclaw-multi-session-plugins
openclaw plugins enable openclaw-multi-session-plugins
```

Or install from a Git checkout for development:

```bash
git clone https://github.com/x-evor/openclaw-multi-session-plugins.git
openclaw plugins install --link ./openclaw-multi-session-plugins
openclaw plugins enable openclaw-multi-session-plugins
```

Equivalent config shape for a linked checkout:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/openclaw-multi-session-plugins"
      ]
    },
    "entries": {
      "openclaw-multi-session-plugins": {
        "enabled": true
      }
    }
  }
}
```

## Contract

Prepare request params are supplied by the OpenClaw host, bridge, or APP
runtime. On OpenClaw runtimes that expose a trusted plugin `sessionScope`, the
plugin uses that native scope first and maps native `sessionScope.sessionKey`
to `openclawSessionKey` internally. External Gateway callers must use typed
`appThreadKey`, `openclawSessionKey`, `runId`, and optional `workspaceDir`
params. Legacy `sessionKey` is not accepted as a Gateway task or artifact lookup
alias. The plugin does not parse paths from chat text and does not invent
fallback session/run identities. The optional agent tool does not expose these
fields to the model; it only uses host-injected tool context.

```json
{
  "appThreadKey": "draft:thread-main",
  "openclawSessionKey": "agent:main:draft:thread-main",
  "runId": "turn-1",
  "workspaceDir": "/home/user/.openclaw/workspace"
}
```

Prepare response payload:

```json
{
  "runId": "turn-1",
  "sessionKey": "agent:main:draft:thread-main",
  "remoteWorkingDirectory": "/home/user/.openclaw/workspace",
  "remoteWorkspaceRefKind": "remotePath",
  "artifactScope": "tasks/thread-main-.../turn-1-...",
  "scopeKind": "task",
  "artifactDirectory": "/home/user/.openclaw/workspace/tasks/thread-main-.../turn-1-...",
  "relativeArtifactDirectory": "tasks/thread-main-.../turn-1-...",
  "warnings": []
}
```

Export request params:

```json
{
  "openclawSessionKey": "agent:main:draft:thread-main",
  "runId": "turn-1",
  "artifactScope": "tasks/thread-main-.../turn-1-...",
  "sinceUnixMs": 1770000000000,
  "maxFiles": 64,
  "maxInlineBytes": 10485760
}
```

Export response payload:

```json
{
  "runId": "turn-1",
  "sessionKey": "agent:main:draft:thread-main",
  "remoteWorkingDirectory": "/home/user/.openclaw/workspace",
  "remoteWorkspaceRefKind": "remotePath",
  "artifactScope": "tasks/thread-main-.../turn-1-...",
  "scopeKind": "task",
  "artifacts": [
    {
      "relativePath": "reports/final.md",
      "label": "final.md",
      "contentType": "text/markdown",
      "sizeBytes": 1234,
      "sha256": "...",
      "artifactRef": "...",
      "artifactScope": "tasks/thread-main-.../turn-1-...",
      "scopeKind": "task"
    }
  ],
  "warnings": []
}
```

Files at or below `maxInlineBytes` also include `encoding: "base64"` and `content`.
When `artifactScope` is omitted, export/list defaults to the current task scope
derived from `openclawSessionKey/runId` for Gateway calls, or from native
`sessionScope.sessionKey/runId` for host-injected tool calls. `sinceUnixMs` is
only a filter inside that task scope. The prepared task scope remains
authoritative: when it contains files, the plugin exports only that scope.

If the prepared task scope is empty, trusted Gateway callers may pass
`expectedArtifactDirs` such as `["assets/images", "reports"]`. The plugin then
scans only those explicit workspace-root subdirectories and labels the exported
files with the current task `artifactScope`. It never performs a broad workspace
root scan, never scans `owners/*/threads/*`, and does not borrow artifacts from
earlier task scopes.

Each exported artifact includes `artifactRef`, a plugin-signed reference over
the issued session/run scope, artifact scope, path, size, and SHA-256 digest. `read` accepts
`artifactScope + relativePath` for the current `openclawSessionKey/runId` task
scope. Signed task `artifactRef` values are accepted only for the same
`openclawSessionKey/runId` that issued them. There is no unscoped arbitrary
workspace read API.

## View And Download

After installation, enable the optional agent tool if you want OpenClaw chat to
show a quick artifact table:

```json5
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": ["openclaw_multi_session_artifacts"]
        }
      }
    ]
  }
}
```

Then ask OpenClaw to list artifacts in the current workspace. The tool returns a
Markdown table with the workspace path, relative file paths, content types, file
sizes, and hash prefixes. Files are still stored in the OpenClaw workspace, so
local users can open or download them directly from that workspace path.

Gateway clients can use:

- `xworkmate.session.prepare` before `chat.send` with typed
  `schemaVersion`, `appThreadKey`, `openclawSessionKey`, `runId`, and
  `expectedArtifactDirs` to allocate a task artifact directory and persist the
  app/OpenClaw session mapping.
- Keep the prepared `artifactScope`/`artifactDirectory` in the gateway artifact
  pipeline, not in `chat.send` params. If `chat.send` returns a different
  OpenClaw `runId`, prepare/export with that actual `runId` instead of the
  bridge request id.
- `xworkmate.artifacts.list` for a metadata-only manifest and Markdown table.
- `xworkmate.artifacts.read` with `artifactScope` and `relativePath` for one task file.
- `xworkmate.artifacts.read` with `artifactRef` for a plugin-returned task file.
- `xworkmate.artifacts.collect-and-snapshot` after `agent.wait` to copy `~/.openclaw/media/` and `/tmp/openclaw/` outputs into the current task scope.
- `xworkmate.artifacts.export` with `artifactScope` after collect-and-snapshot for the XWorkmate APP sync path. Pass `expectedArtifactDirs` when the task contract declares root-level delivery directories.
- `xworkmate.tasks.get` to read the OpenClaw native task state for a run and return the current artifact export in the same payload.

Large files are metadata-only in the export payload, but XWorkmate Bridge can
generate its own signed download URL and call `xworkmate.artifacts.read` as the
only remote file access path.

## Limits

- Only files inside the resolved OpenClaw workspace are exported.
- `.git`, `.openclaw`, `.xworkmate`, `.pi`, transient framework state, and dependency folders are excluded from task artifact exports.
- `dist/`, `build/`, and other delivery directories inside the prepared task scope are exported recursively.
- Export scans workspace-root files only from explicit `expectedArtifactDirs`, only when the prepared task scope is empty, and never from OpenClaw owner/thread workspaces.
- Symlinks are skipped to avoid workspace escape.
- Files larger than `maxInlineBytes` are listed with metadata and a warning, but are not inlined.
- `artifactScope` must be `tasks/<safe-session-key>/<safe-run-id>`.
- `export` and `list` default to the current task scope when `artifactScope` is omitted.
- Direct `artifactScope + relativePath` reads and scoped exports must match the supplied `sessionKey/runId`.
- `artifactRef` is bound to the issued session/run and cannot be reused from another run.
- `artifactScope`, `artifactRef`, and `relativePath` must stay inside the workspace; absolute paths, `..`, empty path segments, and symlink escapes are rejected.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm pack:check
```

### Coding standards

- **No unused exports.** Functions and types that are only used within the same file must not be exported. An `export` keyword signals a public API surface that downstream consumers may depend on.
- **No legacy fallback chains.** When renaming config keys or environment variables, remove the old name from the codebase. Multiple fallback paths to the same dependent service (e.g., two env vars for the same secret) create confusion and mask configuration errors.
- **No hardcoded model identifiers** (e.g., kimi-k2.5, minimax-m2.7, glm-5). Model selection must come from configuration or the bridge.
- **No silent error swallowing.** Every `catch` block must log, warn, rethrow, or return a meaningful fallback. Empty `catch` and `.catch(() => {})` are forbidden.
- **No redundant indirection.** If function A only calls B which only calls C with no added logic, inline or remove the middle function.
- **No stale config references.** Scripts in `package.json`, CI workflows, and documentation must reference only tooling that still exists in the project.
- **Multi-agent references** in bridge protocol parameters (`multiAgent: true`, `mode: "multi-agent"`) are legitimate protocol constants and are not dead code. However, framework-level ARIS or internal multi-agent orchestration code that duplicates bridge functionality must be removed.
