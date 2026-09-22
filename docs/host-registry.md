# Saved host registry

The Rust client stores saved SSH machine connections in `client-hosts.json`
under the client configuration directory (the same directory supplied as
`ConnectOptions::neta_dir`). This file belongs to the client and is separate
from the Node-owned `machine.json`.

Each `SavedHost` has a stable `id`, `displayName`, `sshDestination`, optional
`sshConfig`, `remoteNetaDir`, optional `remoteLauncher` (`executable` and
argument vector), and optional `lastRemoteWorkspacePath`. The last field is a
navigation hint and is not checked against the local filesystem. Credentials,
tokens, and private keys are never fields in this format.

`HostRegistry::load`, `insert`, `update`, and `remove` validate records. IDs
must be unique. The same SSH destination may be saved more than once when its
SSH config or remote NETA directory differs; the complete endpoint tuple must
otherwise be unique. Malformed files return a path-bearing configuration error
and remain untouched. Writes use a same-directory temporary file, mode `0600`,
flush, rename, and directory flush. Newly created parent directories are mode
`0700`; existing directory permissions are left unchanged.
