# NetaDesktop

The Neta macOS app: a thin SwiftUI client of the Neta Node over
`~/.neta/node.sock`. It never owns an agent session; on reconnect it replaces
its cache with one `snapshot` and follows live notifications.

Build and test from this directory:

```sh
swift build
swift test
```
