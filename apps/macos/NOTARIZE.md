# Notarising NetaDesktop.app

Manual runbook. CI never notarises: release zips are ad-hoc signed (see
`scripts/build-app.sh`), so Gatekeeper quarantines the download on a new
machine and the downloader clears it by hand:

```sh
xattr -dr com.apple.quarantine NetaDesktop.app
```

## Signed path (Developer ID + notary)

Build the bundle first and keep its path in `$APP`:

```sh
APP="$(bash apps/macos/scripts/build-app.sh)"
```

1. Sign with a Developer ID, inner binary first, with a timestamp:

```sh
codesign --force --options runtime --timestamp --sign "Developer ID Application: <name> (<TEAMID>)" "$APP/Contents/Resources/neta"
codesign --force --options runtime --timestamp --sign "Developer ID Application: <name> (<TEAMID>)" "$APP"
```

2. Store the notary credentials once:

```sh
xcrun notarytool store-credentials neta-notary --apple-id <apple-id> --team-id <TEAMID> --password <app-specific-password>
```

3. Zip, submit, and read the log:

```sh
ditto -c -k --keepParent "$APP" NetaDesktop.zip
xcrun notarytool submit NetaDesktop.zip --keychain-profile neta-notary --wait
xcrun notarytool log <submission-id> --keychain-profile neta-notary
```

4. Staple the ticket and verify:

```sh
xcrun stapler staple "$APP"
spctl -a -vvv -t install "$APP"
```
