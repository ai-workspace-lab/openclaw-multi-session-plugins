# xworkmate-artifacts

OpenClaw Gateway plugin that exports structured workspace artifact manifests for XWorkmate.

## Why

XWorkmate talks to OpenClaw through `xworkmate-bridge` using the existing
`/gateway/openclaw` task contract. The bridge sends `chat.send`, waits for
`agent.wait`, then asks this plugin for a structured artifact manifest. The APP
can then sync generated files into its local thread workspace without changing
the UI or adding provider-specific routes.

It registers three Gateway methods:

```text
xworkmate.artifacts.export
xworkmate.artifacts.list
xworkmate.artifacts.read
```

The method scans the resolved OpenClaw workspace after a run finishes and returns safe, relative artifact entries that XWorkmate Bridge can normalize into the APP `artifacts[]` contract.

## Install

Install from the npm package through OpenClaw:

```bash
openclaw plugins install xworkmate-artifacts
openclaw plugins enable xworkmate-artifacts
```

Or install from a Git checkout for development:

```bash
git clone https://github.com/x-evor/xworkmate-artifacts.git
openclaw plugins install --link ./xworkmate-artifacts
openclaw plugins enable xworkmate-artifacts
```

Equivalent config shape for a linked checkout:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/xworkmate-artifacts"
      ]
    },
    "entries": {
      "xworkmate-artifacts": {
        "enabled": true
      }
    }
  }
}
```

## Contract

Request params:

```json
{
  "sessionKey": "thread-main",
  "runId": "turn-1",
  "sinceUnixMs": 1770000000000,
  "maxFiles": 64,
  "maxInlineBytes": 10485760
}
```

Response payload:

```json
{
  "runId": "turn-1",
  "sessionKey": "thread-main",
  "remoteWorkingDirectory": "/home/user/.openclaw/workspace",
  "remoteWorkspaceRefKind": "remotePath",
  "artifacts": [
    {
      "relativePath": "reports/final.md",
      "label": "final.md",
      "contentType": "text/markdown",
      "sizeBytes": 1234,
      "sha256": "..."
    }
  ],
  "warnings": []
}
```

Files at or below `maxInlineBytes` also include `encoding: "base64"` and `content`.

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
          "allow": ["xworkmate_artifacts"]
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

- `xworkmate.artifacts.list` for a metadata-only manifest and Markdown table.
- `xworkmate.artifacts.read` with `relativePath` for one inline base64 file.
- `xworkmate.artifacts.export` after `agent.wait` for the XWorkmate APP sync path.

Large files are intentionally metadata-only in v1. XWorkmate Bridge can add a
hosted artifact cache/download endpoint later if remote APP clients need direct
links for large PPT/PDF/DOCX files.

## Limits

- Only files inside the resolved OpenClaw workspace are exported.
- `.git`, `.openclaw`, `.pi`, build outputs, and dependency folders are skipped.
- Symlinks are skipped to avoid workspace escape.
- Files larger than `maxInlineBytes` are listed with metadata and a warning, but are not inlined.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm pack:check
```
