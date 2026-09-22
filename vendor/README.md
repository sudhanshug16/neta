# Vendored dependencies

`vendor/rmux` is the pristine rmux `v0.10.0` source at commit
`dfd68c774ca0f4212139a21d37d09c90f75f8bd7`. The imported source archive had
SHA-256 `010f4a5f0c00874ec7a7772f3b4f6babe0f6bc291b5a499e16399171d3231949`.
Neta uses the vendored `rmux-sdk` and `ratatui-rmux` crates through root Cargo
workspace path dependencies. The vendored workspace is excluded from Neta's
workspace so its upstream manifests, lockfile, licenses, and checks stay intact.

To update it, verify the exact upstream tag-to-commit mapping and archive
checksum (and its signature when upstream provides one), replace the complete
`vendor/rmux` tree without edits, then run the root Cargo and PTY tests.
Adapter changes belong in `crates/neta-terminal`. Future engine fixes can live
as ordered patches outside the pristine baseline under `vendor/patches/rmux`,
applied to a build staging tree, or as an explicitly documented tracked fork.
There are no Neta engine patches yet.
