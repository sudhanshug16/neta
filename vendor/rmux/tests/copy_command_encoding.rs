//! Issue #177: the shipped Windows `copy-command` recipe must round-trip UTF-8.
//!
//! RMUX writes a copy-mode selection to the `copy-command` child's standard
//! input as raw UTF-8 bytes and never transcodes it, exactly like tmux. On
//! Windows that contract is not self-enforcing: RMUX runs the child in a hidden
//! console (`CREATE_NO_WINDOW`), and a console child that does not declare an
//! input encoding decodes stdin with the machine's OEM code page. The recipe
//! RMUX ships therefore has to declare UTF-8 itself; a bare `clip.exe` does
//! not, which is how `U+2500` reaches the clipboard as `ΓöÇ`.

use std::path::PathBuf;

/// The declaration that makes a PowerShell clipboard command read RMUX's raw
/// UTF-8 stdin as UTF-8 instead of as the OEM code page.
const UTF8_INPUT_ENCODING_DECLARATION: &str = "[Console]::InputEncoding=[Text.Encoding]::UTF8";

/// Byte-oriented Windows clipboard commands that inherit the console code page.
/// Shipping any of these as the Windows recipe reintroduces issue #177.
const OEM_DECODING_COMMANDS: &[&str] = &["clip.exe", "$input | Set-Clipboard"];

fn repo_file(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("reading {} failed: {error}", path.display()))
}

/// Extracts the Windows `copy-command` recipe from a shipped document. The
/// Windows entry is the only one that invokes a shell interpreter, so it is
/// identified by that rather than by line number.
fn windows_copy_command_recipe(contents: &str, source: &str) -> String {
    let recipe = contents
        .lines()
        .filter(|line| line.contains("copy-command") || line.contains("- Windows:"))
        .find(|line| line.contains("powershell"))
        .unwrap_or_else(|| panic!("{source} no longer documents a Windows copy-command recipe"));
    recipe.trim().to_owned()
}

#[test]
fn shipped_windows_copy_command_declares_an_explicit_utf8_input_encoding() {
    for source in [
        "docs/examples/human-friendly.conf",
        "docs/human-friendly-config.md",
    ] {
        let recipe = windows_copy_command_recipe(&repo_file(source), source);
        assert!(
            recipe.contains(UTF8_INPUT_ENCODING_DECLARATION),
            "{source} documents a Windows copy-command that does not declare its input \
             encoding, so it decodes RMUX's UTF-8 selection with the OEM code page \
             (issue #177): {recipe}"
        );
    }
}

#[test]
fn shipped_documents_no_longer_recommend_oem_decoding_clipboard_commands() {
    for source in [
        "docs/examples/human-friendly.conf",
        "docs/human-friendly-config.md",
    ] {
        let contents = repo_file(source);
        for line in contents.lines() {
            // The prose deliberately names these commands to explain why they
            // are unsafe; only `set -s copy-command` recommendations matter.
            if !line.contains("set -s copy-command") {
                continue;
            }
            for rejected in OEM_DECODING_COMMANDS {
                assert!(
                    !line.contains(rejected),
                    "{source} recommends `{rejected}` as a copy-command; it decodes RMUX's \
                     UTF-8 selection with the OEM code page (issue #177): {line}"
                );
            }
        }
    }
}

#[cfg(windows)]
mod windows_round_trip {
    use super::UTF8_INPUT_ENCODING_DECLARATION;

    use std::io::Write;
    use std::process::{Command, Stdio};

    /// Box drawing (the glyphs in issue #177), Latin-1 accents, a non-BMP
    /// emoji, and CJK. Every character is multi-byte in UTF-8, so a code-page
    /// transcode anywhere on the path changes these bytes.
    const FIXTURE: &str = "╭─│╯ café 😀 日本";

    struct Decoded {
        text: String,
        default_input_code_page: u32,
    }

    /// Runs a PowerShell reader over the fixture bytes exactly as RMUX's
    /// `copy-pipe` child receives them: raw UTF-8 on stdin, no BOM, no
    /// transcoding by RMUX. `declaration` is the encoding prelude under test.
    fn decode_with(declaration: &str) -> Decoded {
        let script = format!(
            "$cp=[Console]::InputEncoding.CodePage; {declaration} \
             $text=[Console]::In.ReadToEnd(); \
             [Console]::OutputEncoding=[Text.Encoding]::UTF8; \
             [Console]::Out.Write(\"$cp`n$text\")"
        );
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawning powershell.exe for the copy-command probe");
        child
            .stdin
            .take()
            .expect("powershell stdin is piped")
            .write_all(FIXTURE.as_bytes())
            .expect("writing the fixture to the probe's stdin");
        let output = child.wait_with_output().expect("probe runs to completion");
        assert!(
            output.status.success(),
            "probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let stdout = String::from_utf8(output.stdout).expect("probe emits UTF-8");
        let (code_page, text) = stdout
            .split_once('\n')
            .expect("probe emits the code page then the decoded text");
        Decoded {
            text: text.trim_end_matches(['\r', '\n']).to_owned(),
            default_input_code_page: code_page
                .trim()
                .parse()
                .expect("probe reports a numeric code page"),
        }
    }

    #[test]
    fn declared_utf8_input_encoding_round_trips_the_selection_byte_exactly() {
        let decoded = decode_with(&format!("{UTF8_INPUT_ENCODING_DECLARATION};"));
        assert_eq!(
            decoded.text, FIXTURE,
            "a copy-command that declares UTF-8 must return RMUX's selection unchanged"
        );
    }

    #[test]
    fn undeclared_input_encoding_corrupts_the_selection() {
        // This is the pre-fix behaviour, and the reason the recipe has to carry
        // the declaration: without it PowerShell (like clip.exe) reads RMUX's
        // stdin with the console's OEM code page. A machine already running a
        // UTF-8 console code page cannot demonstrate the defect, so the
        // assertion is scoped to the configuration that can.
        let decoded = decode_with("");
        if decoded.default_input_code_page == 65001 {
            eprintln!(
                "skipping: this host already defaults to code page 65001, so the OEM \
                 decode of issue #177 cannot be reproduced here"
            );
            return;
        }
        assert_ne!(
            decoded.text, FIXTURE,
            "expected the undeclared reader to mangle the selection through code page {}",
            decoded.default_input_code_page
        );
    }
}
