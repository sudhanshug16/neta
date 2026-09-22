# Pi RPC component proof

Run from the repository root (requires loopback networking and PTY access):

```sh
node prototypes/pi-rpc-proof/component-tui-proof.mjs
```

This runs a real Pi 0.85.0 headless `--mode rpc` subprocess against a deterministic
local OpenAI-compatible fake model. A separate PTY client composes upstream
`createInteractiveTui`, `CustomEditor`, `UserMessageComponent`,
`AssistantMessageComponent`, `ToolExecutionComponent`, and `SelectList` in a
small `RemoteChatMode`. No production, vendor, or node_modules files are changed.
No paid model API is called.

The harness types a prompt into the editor, observes the first streamed fragment
before releasing the next fragment, queues exact steering while a tool's confirm
dialog is open, switches back with Tab and accepts the upstream SelectList.
It verifies the exact steering user message in the fake model's next request,
tool update/end events, confirmed=true, and a marker written by the host tool
in the host working directory. It closes both processes, reopens the persisted
session in a fresh host/UI pair, and asserts restored prompt, steering, tool
marker, and final assistant text in the PTY output.

Host and client have distinct working/config directories. The client receives a
minimal environment and has no model or auth files; only the host has the fake
provider configuration. These are process/config boundaries, not a security
sandbox: the client launches the host and both share the same OS user/filesystem.

`artifacts/evidence.json` records assertions and temporary session paths.
`first.pty.txt` and `reconnected.pty.txt` contain actual terminal escape sequences;
the matching `.rpc.jsonl` files capture received host events. Runs replace these
artifacts; the persisted sessions remain in the reported temporary directory.

Limits: this is **not unmodified InteractiveMode** attached to RpcClient. It
imports internal components pinned to Pi 0.85.0 and implements a limited RPC
controller (text streaming, prompt/steer, tool events, confirm/notify, history).
Historical tool results currently render as text; live tools use upstream
ToolExecutionComponent. Compact streaming delta reduction currently handles text only, not thinking or
tool-argument streaming. Other extension UI methods, custom extension renderer
parity, retries, abort controls, model switching, slash commands, full
editor/application shortcuts, and SSH transport are not proved.

`node prototypes/pi-rpc-proof/proof.mjs` is the earlier protocol-only proof.
`experimental-tui-proof.mjs` is a separate diagnostic of Pi's experimental Unix
service client, which failed with upstream EPIPE here. It does not provide a
passing remote UI proof and is not part of the working component harness.
