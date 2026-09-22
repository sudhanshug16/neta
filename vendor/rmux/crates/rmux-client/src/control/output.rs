use std::io::{self, Read, Write};

const EXIT_RECORD_PREFIX: &[u8] = b"%exit";

#[derive(Debug, Default)]
struct ControlOutputProgress {
    line: ControlLine,
    terminal_exit_delivered: bool,
}

#[derive(Debug)]
enum ControlLine {
    Prefix(usize),
    ExitReason,
    Other,
}

impl Default for ControlLine {
    fn default() -> Self {
        Self::Prefix(0)
    }
}

impl ControlOutputProgress {
    fn observe(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.observe_byte(*byte);
        }
    }

    fn observe_byte(&mut self, byte: u8) {
        if matches!(self.line, ControlLine::Prefix(0)) && self.terminal_exit_delivered {
            self.terminal_exit_delivered = false;
        }

        self.line = match std::mem::take(&mut self.line) {
            ControlLine::Prefix(matched) if matched < EXIT_RECORD_PREFIX.len() => {
                if byte == EXIT_RECORD_PREFIX[matched] {
                    ControlLine::Prefix(matched + 1)
                } else if byte == b'\n' {
                    self.complete_line(false)
                } else {
                    ControlLine::Other
                }
            }
            ControlLine::Prefix(_) if byte == b'\n' => self.complete_line(true),
            ControlLine::Prefix(_) if byte == b' ' => ControlLine::ExitReason,
            ControlLine::Prefix(_) => ControlLine::Other,
            ControlLine::ExitReason if byte == b'\n' => self.complete_line(true),
            ControlLine::ExitReason => ControlLine::ExitReason,
            ControlLine::Other if byte == b'\n' => self.complete_line(false),
            ControlLine::Other => ControlLine::Other,
        };
    }

    fn complete_line(&mut self, is_exit: bool) -> ControlLine {
        self.terminal_exit_delivered = is_exit;
        ControlLine::Prefix(0)
    }
}

pub(super) fn copy_control_output<R>(mut stream: R, output: &mut impl Write) -> io::Result<()>
where
    R: Read,
{
    let mut buffer = [0_u8; 8192];
    let mut progress = ControlOutputProgress::default();

    loop {
        let bytes_read = match stream.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(bytes_read) => bytes_read,
            Err(error)
                if progress.terminal_exit_delivered && peer_closed_control_stream(&error) =>
            {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        output.write_all(&buffer[..bytes_read])?;
        output.flush()?;
        progress.observe(&buffer[..bytes_read]);
    }
}

fn peer_closed_control_stream(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionReset | io::ErrorKind::NotConnected | io::ErrorKind::UnexpectedEof
    )
}

#[cfg(test)]
mod tests {
    use super::copy_control_output;
    use std::io::{self, Read};

    struct BytesThenReset {
        bytes: Option<&'static [u8]>,
    }

    impl Read for BytesThenReset {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let Some(bytes) = self.bytes.take() else {
                return Err(io::Error::from(io::ErrorKind::ConnectionReset));
            };
            buffer[..bytes.len()].copy_from_slice(bytes);
            Ok(bytes.len())
        }
    }

    #[test]
    fn complete_exit_record_makes_peer_reset_a_clean_control_end() {
        let mut output = Vec::new();

        copy_control_output(
            BytesThenReset {
                bytes: Some(b"%begin 1 1 0\n%end 1 1 0\n%exit\n"),
            },
            &mut output,
        )
        .expect("terminal exit was delivered before reset");

        assert_eq!(output, b"%begin 1 1 0\n%end 1 1 0\n%exit\n");
    }

    #[test]
    fn partial_exit_record_does_not_hide_peer_reset() {
        let error = copy_control_output(
            BytesThenReset {
                bytes: Some(b"%begin 1 1 0\n%end 1 1 0\n%exi"),
            },
            &mut Vec::new(),
        )
        .expect_err("truncated control output is not a clean exit");

        assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
    }
}
