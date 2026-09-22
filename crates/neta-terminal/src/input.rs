use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

pub fn key_token(event: KeyEvent) -> Option<String> {
    let code = match event.code {
        KeyCode::Backspace => "BSpace".to_owned(),
        KeyCode::Enter => "Enter".to_owned(),
        KeyCode::Left => "Left".to_owned(),
        KeyCode::Right => "Right".to_owned(),
        KeyCode::Up => "Up".to_owned(),
        KeyCode::Down => "Down".to_owned(),
        KeyCode::Home => "Home".to_owned(),
        KeyCode::End => "End".to_owned(),
        KeyCode::PageUp => "PageUp".to_owned(),
        KeyCode::PageDown => "PageDown".to_owned(),
        KeyCode::Tab => "Tab".to_owned(),
        KeyCode::BackTab => "BTab".to_owned(),
        KeyCode::Delete => "DC".to_owned(),
        KeyCode::Insert => "IC".to_owned(),
        KeyCode::Esc => "Escape".to_owned(),
        KeyCode::F(n) => format!("F{n}"),
        KeyCode::Char(_)
            if event.modifiers.is_empty() || event.modifiers == KeyModifiers::SHIFT =>
        {
            return None
        }
        KeyCode::Char(ch) => ch.to_string(),
        _ => return None,
    };
    let mut prefix = Vec::new();
    if event.modifiers.contains(KeyModifiers::CONTROL) {
        prefix.push("C");
    }
    if event.modifiers.contains(KeyModifiers::ALT) {
        prefix.push("M");
    }
    if event.modifiers.contains(KeyModifiers::SHIFT) {
        prefix.push("S");
    }
    Some(if prefix.is_empty() {
        code
    } else {
        format!("{}-{code}", prefix.join("-"))
    })
}

pub fn mouse_sequence(event: MouseEvent, origin_x: u16, origin_y: u16) -> Option<String> {
    let col = event.column.checked_sub(origin_x)? + 1;
    let row = event.row.checked_sub(origin_y)? + 1;
    let (button, release) = match event.kind {
        MouseEventKind::Down(MouseButton::Left) => (0, false),
        MouseEventKind::Down(MouseButton::Middle) => (1, false),
        MouseEventKind::Down(MouseButton::Right) => (2, false),
        MouseEventKind::Up(_) => (0, true),
        MouseEventKind::Drag(MouseButton::Left) => (32, false),
        MouseEventKind::Moved => (35, false),
        MouseEventKind::ScrollUp => (64, false),
        MouseEventKind::ScrollDown => (65, false),
        MouseEventKind::ScrollLeft => (66, false),
        MouseEventKind::ScrollRight => (67, false),
        _ => return None,
    };
    let suffix = if release { 'm' } else { 'M' };
    Some(format!("\x1b[<{button};{col};{row}{suffix}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_control_and_alt() {
        assert_eq!(
            key_token(KeyEvent::new(
                KeyCode::Char('x'),
                KeyModifiers::CONTROL | KeyModifiers::ALT
            )),
            Some("C-M-x".into())
        );
        assert_eq!(
            key_token(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE)),
            Some("Up".into())
        );
    }
    #[test]
    fn uses_rmux_canonical_special_key_names() {
        assert_eq!(
            key_token(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE)),
            Some("BSpace".into())
        );
        assert_eq!(
            key_token(KeyEvent::new(KeyCode::Backspace, KeyModifiers::ALT)),
            Some("M-BSpace".into())
        );
        assert_eq!(
            key_token(KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE)),
            Some("PageUp".into())
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rmux_sdk_writes_backspace_as_del() -> Result<(), Box<dyn std::error::Error>> {
        use rmux_sdk::{
            EnsureSession, EnsureSessionPolicy, ProcessSpec, Rmux, SessionName, TerminalSizeSpec,
        };
        use std::{path::PathBuf, time::Duration};
        let runtime =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.cache/rmux/libexec/rmux/rmux");
        std::env::set_var("RMUX_SDK_DAEMON_BINARY", runtime);
        let socket =
            std::env::temp_dir().join(format!("neta-rmux-key-test-{}.sock", std::process::id()));
        let rmux = Rmux::builder()
            .unix_socket(&socket)
            .default_timeout(Duration::from_secs(8))
            .connect_or_start()
            .await?;
        let script = "import os,termios; a=termios.tcgetattr(0); a[3] &= ~(termios.ICANON|termios.ECHO); termios.tcsetattr(0,termios.TCSANOW,a); os.write(1,b'READY'); b=os.read(0,1); os.write(1,b'BYTE:'+b.hex().encode()+b'\\x1b]0;bad\\x07\\x1b]52;c;eA==\\x07'); os.read(0,1)";
        let session = rmux
            .ensure_session(
                EnsureSession::named(SessionName::new("key-bytes")?)
                    .policy(EnsureSessionPolicy::CreateOrReuse)
                    .detached(true)
                    .size(TerminalSizeSpec::new(40, 8))
                    .process(ProcessSpec::argv(["python3", "-c", script])),
            )
            .await?;
        let pane = session.pane(0, 0);
        pane.wait_for_text("READY").await?;
        let mut output = pane.output_stream().await?;
        let token = key_token(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE))
            .expect("mapped Backspace");
        pane.send_key(token).await?;
        pane.wait_for_text("BYTE:7f").await?;
        let mut parser = crate::clipboard::Osc52Parser::default();
        let forwarded = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(rmux_sdk::PaneOutputChunk::Bytes { bytes, .. }) = output.next().await? {
                    let accepted = parser.feed(&bytes);
                    if !accepted.is_empty() {
                        break Ok::<_, rmux_sdk::RmuxError>(accepted);
                    }
                }
            }
        })
        .await??;
        assert_eq!(forwarded, vec![b"\x1b]52;c;eA==\x07".to_vec()]);
        rmux.shutdown().await?;
        let _ = std::fs::remove_file(socket);
        Ok(())
    }
}
