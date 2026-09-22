# Vendored dependencies

`vendor/opencode` records the exact upstream OpenCode commit and reviewed source
overlay used by Neta's native terminal client. Run `bun run setup:opencode` to
create or verify an isolated checkout, and `bun run export:opencode` only after
reviewing intentional fork changes.
