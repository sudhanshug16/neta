# Bundled Codex ACP adapter

Neta Desktop bundles `@agentclientprotocol/codex-acp` 1.10.0 from npm and
`@openai/codex` 0.153.4. The exact packages are locked in `bun.lock`.

The adapter carries the compiled equivalent of upstream change
agentclientprotocol/codex-acp#441, commit
`84bfbe8318400b139214e9aa51352585aae19368`. It preserves the host-owned
`promptRequired` steering fallback during idle and completion races. The
checked-in Bun patch is the complete local modification.

Upstream: https://github.com/agentclientprotocol/codex-acp
Patch: https://github.com/agentclientprotocol/codex-acp/pull/441
License: Apache-2.0; see the upstream package license.
