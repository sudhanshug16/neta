//! Fragmentation-safe WebShare policy boundary.
//!
//! Visual OSC commands on the allowlist survive. Clipboard OSC 52, unknown
//! OSC commands, and every APC/DCS/PM/SOS string (including Kitty graphics and
//! SIXEL) are dropped rather than delegated to browser-terminal behavior.
//!
//! RMUX decodes UTF-8 only in Ground. Encoded C1 code points are therefore
//! zero-width text for the pane owner, while xterm.js would reinterpret them as
//! terminal controls. This boundary removes those nonprinting code points and
//! replaces malformed Ground UTF-8 with U+FFFD before xterm.js sees it.

use super::WebShareConnectRole;

const MAX_BUFFERED_OSC_BYTES: usize = 1024 * 1024;
const HYPERLINK_CLOSE_ST: &[u8] = b"\x1b]8;;\x1b\\";
const UTF8_REPLACEMENT: &[u8] = "\u{fffd}".as_bytes();

#[derive(Debug)]
pub(crate) struct WebTerminalSanitizer {
    role: WebShareConnectRole,
    state: State,
    pending_utf8: Option<PendingUtf8>,
}

#[derive(Debug, Default)]
enum State {
    #[default]
    Ground,
    Escape,
    Osc {
        bytes: Vec<u8>,
        escaped: bool,
    },
    DiscardString(DiscardString),
    Dcs(DcsState),
}

#[derive(Debug)]
struct DiscardString {
    escaped: bool,
    terminator: StringTerminator,
    completion: DiscardCompletion,
}

impl DiscardString {
    const fn new(terminator: StringTerminator) -> Self {
        Self {
            escaped: false,
            terminator,
            completion: DiscardCompletion::Drop,
        }
    }

    const fn with_escape(
        terminator: StringTerminator,
        escaped: bool,
        completion: DiscardCompletion,
    ) -> Self {
        Self {
            escaped,
            terminator,
            completion,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum DiscardCompletion {
    Drop,
    CloseHyperlink,
}

#[derive(Debug, Clone, Copy)]
enum StringTerminator {
    St,
    StOrBel,
}

#[derive(Debug)]
enum DcsState {
    Entry,
    Parameter,
    Intermediate,
    Ignore,
    Passthrough,
    PassthroughEscape,
}

#[derive(Debug)]
struct PendingUtf8 {
    bytes: [u8; 4],
    len: u8,
    expected: u8,
}

impl PendingUtf8 {
    fn start(byte: u8) -> Option<Self> {
        let expected = match byte {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return None,
        };
        let mut bytes = [0; 4];
        bytes[0] = byte;
        Some(Self {
            bytes,
            len: 1,
            expected,
        })
    }

    fn push_continuation(&mut self, byte: u8) -> bool {
        if byte & 0xc0 != 0x80 {
            return false;
        }
        self.bytes[usize::from(self.len)] = byte;
        self.len += 1;
        true
    }

    const fn is_complete(&self) -> bool {
        self.len == self.expected
    }

    fn bytes(&self) -> &[u8] {
        &self.bytes[..usize::from(self.len)]
    }
}

impl Default for WebTerminalSanitizer {
    fn default() -> Self {
        Self::for_role(WebShareConnectRole::Operator)
    }
}

impl WebTerminalSanitizer {
    pub(crate) fn for_role(role: WebShareConnectRole) -> Self {
        Self {
            role,
            state: State::Ground,
            pending_utf8: None,
        }
    }

    pub(crate) fn push(&mut self, input: &[u8], output: &mut Vec<u8>) {
        for byte in input.iter().copied() {
            self.push_byte(byte, output);
        }
    }

    pub(crate) fn reset(&mut self) {
        self.state = State::Ground;
        self.pending_utf8 = None;
    }

    fn push_byte(&mut self, byte: u8, output: &mut Vec<u8>) {
        if let Some(mut pending) = self.pending_utf8.take() {
            if pending.push_continuation(byte) {
                if pending.is_complete() {
                    forward_ground_utf8(&pending, output);
                } else {
                    self.pending_utf8 = Some(pending);
                }
                return;
            }
            output.extend_from_slice(UTF8_REPLACEMENT);
        }

        if matches!(self.state, State::Ground) && byte >= 0x80 {
            if let Some(pending) = PendingUtf8::start(byte) {
                self.pending_utf8 = Some(pending);
            } else {
                output.extend_from_slice(UTF8_REPLACEMENT);
            }
            return;
        }

        self.process_byte(byte, output);
    }

    fn process_byte(&mut self, byte: u8, output: &mut Vec<u8>) {
        let state = std::mem::take(&mut self.state);
        self.state = match state {
            State::Ground => ground(byte, output),
            State::Escape => escape_sequence(byte, output),
            State::Osc { mut bytes, escaped } => {
                if escaped && byte != b'\\' {
                    close_rejected_hyperlink(&bytes, self.role, output);
                    escape_sequence(byte, output)
                } else if escaped || byte == 0x07 {
                    bytes.push(byte);
                    complete_osc(&bytes, self.role, output);
                    State::Ground
                } else if cancelled(byte) {
                    State::Ground
                } else if bytes.len() >= MAX_BUFFERED_OSC_BYTES {
                    State::DiscardString(DiscardString::with_escape(
                        StringTerminator::StOrBel,
                        byte == 0x1b,
                        if is_hyperlink_osc(&bytes) {
                            DiscardCompletion::CloseHyperlink
                        } else {
                            DiscardCompletion::Drop
                        },
                    ))
                } else {
                    bytes.push(byte);
                    State::Osc {
                        bytes,
                        escaped: byte == 0x1b,
                    }
                }
            }
            State::DiscardString(string) => discard_string(string, byte, output),
            State::Dcs(dcs) => dcs_sequence(dcs, byte),
        };
    }
}

fn forward_ground_utf8(sequence: &PendingUtf8, output: &mut Vec<u8>) {
    let Ok(value) = std::str::from_utf8(sequence.bytes()) else {
        output.extend_from_slice(UTF8_REPLACEMENT);
        return;
    };
    let Some(character) = value.chars().next() else {
        output.extend_from_slice(UTF8_REPLACEMENT);
        return;
    };
    if !matches!(u32::from(character), 0x80..=0x9f) {
        output.extend_from_slice(sequence.bytes());
    }
}

fn ground(byte: u8, output: &mut Vec<u8>) -> State {
    match byte {
        0x1b => State::Escape,
        0x18 | 0x1a => State::Ground,
        _ => {
            output.push(byte);
            State::Ground
        }
    }
}

fn escape_sequence(byte: u8, output: &mut Vec<u8>) -> State {
    if cancelled(byte) {
        return State::Ground;
    }
    match byte {
        b']' => State::Osc {
            bytes: vec![0x1b, b']'],
            escaped: false,
        },
        b'P' => State::Dcs(DcsState::Entry),
        b'X' | b'^' | b'_' | b'k' => State::DiscardString(DiscardString::new(StringTerminator::St)),
        // Executing a C0 control does not leave the terminal's Escape state.
        0x00..=0x17 | 0x19 | 0x1c..=0x1f => {
            output.push(byte);
            State::Escape
        }
        0x1b => State::Escape,
        0x7f..=0xff => State::Escape,
        _ => {
            output.push(0x1b);
            output.push(byte);
            State::Ground
        }
    }
}

fn discard_string(mut string: DiscardString, byte: u8, output: &mut Vec<u8>) -> State {
    if string.escaped {
        return if byte == b'\\' {
            complete_discard(string.completion, output);
            State::Ground
        } else {
            complete_discard(string.completion, output);
            escape_sequence(byte, output)
        };
    }
    if cancelled(byte) {
        return State::Ground;
    }
    if matches!(string.terminator, StringTerminator::StOrBel) && byte == 0x07 {
        complete_discard(string.completion, output);
        return State::Ground;
    }
    string.escaped = byte == 0x1b;
    State::DiscardString(string)
}

fn complete_discard(completion: DiscardCompletion, output: &mut Vec<u8>) {
    if matches!(completion, DiscardCompletion::CloseHyperlink) {
        output.extend_from_slice(HYPERLINK_CLOSE_ST);
    }
}

fn complete_osc(sequence: &[u8], role: WebShareConnectRole, output: &mut Vec<u8>) {
    match osc_disposition(sequence, role) {
        OscDisposition::Forward => output.extend_from_slice(sequence),
        OscDisposition::Drop => {}
        OscDisposition::CloseHyperlink => output.extend_from_slice(HYPERLINK_CLOSE_ST),
    }
}

fn close_rejected_hyperlink(sequence: &[u8], role: WebShareConnectRole, output: &mut Vec<u8>) {
    if matches!(
        osc_disposition(sequence, role),
        OscDisposition::CloseHyperlink
    ) {
        output.extend_from_slice(HYPERLINK_CLOSE_ST);
    }
}

fn dcs_sequence(state: DcsState, byte: u8) -> State {
    match state {
        DcsState::Entry => match byte {
            0x18 | 0x1a => State::Ground,
            0x1b => State::Escape,
            0x20..=0x2f => State::Dcs(DcsState::Intermediate),
            0x30..=0x39 | 0x3b..=0x3f => State::Dcs(DcsState::Parameter),
            0x3a => State::Dcs(DcsState::Ignore),
            0x40..=0x7e => State::Dcs(DcsState::Passthrough),
            _ => State::Dcs(DcsState::Entry),
        },
        DcsState::Parameter => match byte {
            0x18 | 0x1a => State::Ground,
            0x1b => State::Escape,
            0x20..=0x2f => State::Dcs(DcsState::Intermediate),
            0x30..=0x39 | 0x3b => State::Dcs(DcsState::Parameter),
            0x3a | 0x3c..=0x3f => State::Dcs(DcsState::Ignore),
            0x40..=0x7e => State::Dcs(DcsState::Passthrough),
            _ => State::Dcs(DcsState::Parameter),
        },
        DcsState::Intermediate => match byte {
            0x18 | 0x1a => State::Ground,
            0x1b => State::Escape,
            0x20..=0x2f => State::Dcs(DcsState::Intermediate),
            0x30..=0x3f => State::Dcs(DcsState::Ignore),
            0x40..=0x7e => State::Dcs(DcsState::Passthrough),
            _ => State::Dcs(DcsState::Intermediate),
        },
        DcsState::Ignore => match byte {
            0x18 | 0x1a => State::Ground,
            0x1b => State::Escape,
            _ => State::Dcs(DcsState::Ignore),
        },
        DcsState::Passthrough => {
            if byte == 0x1b {
                State::Dcs(DcsState::PassthroughEscape)
            } else {
                State::Dcs(DcsState::Passthrough)
            }
        }
        DcsState::PassthroughEscape => {
            if byte == b'\\' {
                State::Ground
            } else {
                State::Dcs(DcsState::Passthrough)
            }
        }
    }
}

const fn cancelled(byte: u8) -> bool {
    matches!(byte, 0x18 | 0x1a)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OscDisposition {
    Forward,
    Drop,
    CloseHyperlink,
}

fn osc_disposition(sequence: &[u8], role: WebShareConnectRole) -> OscDisposition {
    let Some(payload) = sequence.strip_prefix(b"\x1b]".as_slice()) else {
        return OscDisposition::Drop;
    };
    let encoded_c1 = payload
        .windows(2)
        .any(|pair| pair[0] == 0xc2 && (0x80..=0x9f).contains(&pair[1]));
    let code_end = payload
        .iter()
        .position(|byte| *byte == b';' || *byte == 0x07 || *byte == 0x1b)
        .unwrap_or(payload.len());
    let Ok(code) = std::str::from_utf8(&payload[..code_end]) else {
        return OscDisposition::Drop;
    };
    if code == "8" {
        return if !encoded_c1 && allowed_hyperlink(&payload[code_end..]) {
            OscDisposition::Forward
        } else {
            OscDisposition::CloseHyperlink
        };
    }
    if encoded_c1 {
        return OscDisposition::Drop;
    }
    let visual = matches!(
        code,
        "4" | "10" | "11" | "12" | "104" | "110" | "111" | "112"
    );
    let private_metadata = matches!(code, "0" | "1" | "2" | "7" | "133");
    if visual || (matches!(role, WebShareConnectRole::Operator) && private_metadata) {
        OscDisposition::Forward
    } else {
        OscDisposition::Drop
    }
}

fn is_hyperlink_osc(sequence: &[u8]) -> bool {
    let Some(payload) = sequence.strip_prefix(b"\x1b]".as_slice()) else {
        return false;
    };
    let code_end = payload
        .iter()
        .position(|byte| *byte == b';' || *byte == 0x07 || *byte == 0x1b)
        .unwrap_or(payload.len());
    std::str::from_utf8(&payload[..code_end]) == Ok("8")
}

fn allowed_hyperlink(payload: &[u8]) -> bool {
    let payload = payload.strip_prefix(b";").unwrap_or(payload);
    let payload = strip_osc_terminator(payload);
    let Some(separator) = payload.iter().position(|byte| *byte == b';') else {
        return false;
    };
    let uri = &payload[separator + 1..];
    if uri.is_empty() {
        return true;
    }
    let Ok(uri) = std::str::from_utf8(uri) else {
        return false;
    };
    let Some((scheme, _)) = uri.split_once(':') else {
        return false;
    };
    matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "mailto"
    )
}

fn strip_osc_terminator(mut payload: &[u8]) -> &[u8] {
    if payload.ends_with(b"\x1b\\") {
        payload = &payload[..payload.len() - 2];
    } else if payload.last() == Some(&0x07) {
        payload = &payload[..payload.len() - 1];
    }
    payload
}

#[cfg(test)]
#[path = "stream_sanitizer/oracle_tests.rs"]
mod oracle_tests;

#[cfg(test)]
#[path = "stream_sanitizer/tests.rs"]
mod tests;
