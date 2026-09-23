# Settings

Neta reads `$NETA_DIR/settings.json` (default `~/.neta/settings.json`), then
`<workspace>/.neta/settings.json`. Workspace fields win. Provider objects merge
field by field; arrays replace. Missing or malformed files leave the lower
layer in place and produce a warning.

```json
{
  "providers": {
    "opencode": {
      "command": "opencode",
      "args": ["serve"],
      "env": {},
      "resume": true,
      "defaultModel": ""
    }
  },
  "leader": { "provider": "opencode" },
  "forbiddenModels": []
}
```

OpenCode is the only selectable runtime. Neta starts its pinned, managed
OpenCode V2 build from `vendor/opencode`; `command` and `args` must retain the
shown values. They describe the supported runtime rather than selecting an
executable from the workspace or `PATH`. The previous shipped `args: ["acp"]`
value advances to `["serve"]` in memory with a warning. Other custom launch
tuples fail clearly instead of being silently ignored.

`env` adds environment variables to the private OpenCode server. `defaultModel`
may select a connected model by its full `provider/model` ID; an empty value
uses OpenCode's connected default. `resume: true` preserves saved native session
IDs on restart. `disabled: true` prevents a new session. Existing settings
entries for retired runtimes remain readable as historical configuration, but
Neta cannot launch or switch to them.

`leader.model` overrides the leader's default model. `forbiddenModels` is an
exact match ban list for model IDs. Connected model choices come from OpenCode's
live model catalog. Skills and charters are configured separately in the
workspace and user `.neta` directories.

The `neta mcp` proxy receives `NETA_SOCKET` and a minted actor token when
OpenCode connects it. Neta checks the private server's MCP state before turns
and restores tool registration after OpenCode evicts idle location services.
