# NetaDesktop

The Neta macOS app: a thin SwiftUI client of the Neta Node over
`~/.neta/node.sock`. It never owns an agent session; on reconnect it replaces
its cache with one `snapshot` and follows live notifications.

Build and test from this directory:

```sh
swift build
swift test
```

## Building the app

From the repo root (the script resolves the repo from its own path, so it
also works from any working directory):

```sh
bash apps/macos/scripts/build-app.sh
```

The bundle lands at `apps/macos/.build/NetaDesktop.app` — pass an output
directory as the first argument to put it elsewhere. The script prints the
bundle's absolute path as its last line.

The bundle ships the compiled `neta` CLI at `Contents/Resources/neta`, so
the Node runs with neither npm nor Bun installed.
