const PREFIX: &[u8] = b"\x1b]52;";
const MAX_PAYLOAD: usize = 100_000;

#[derive(Default)]
pub struct Osc52Parser {
    pending: Vec<u8>,
}

impl Osc52Parser {
    pub fn reset(&mut self) {
        self.pending.clear();
    }
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(bytes);
        let mut accepted = Vec::new();
        loop {
            let Some(start) = find(&self.pending, PREFIX) else {
                let keep = suffix_prefix_len(&self.pending, PREFIX);
                self.pending
                    .drain(..self.pending.len().saturating_sub(keep));
                break;
            };
            if start > 0 {
                self.pending.drain(..start);
            }
            let body_start = PREFIX.len();
            let Some((end, terminal_len)) = terminator(&self.pending[body_start..]) else {
                if self.pending.len() > PREFIX.len() + MAX_PAYLOAD + 8 {
                    self.pending.clear();
                }
                break;
            };
            let end = body_start + end;
            let whole_end = end + terminal_len;
            if valid_body(&self.pending[body_start..end]) {
                accepted.push(self.pending[..whole_end].to_vec());
            }
            self.pending.drain(..whole_end);
        }
        accepted
    }
}

fn valid_body(body: &[u8]) -> bool {
    let Some(separator) = body.iter().position(|byte| *byte == b';') else {
        return false;
    };
    let selector = &body[..separator];
    let payload = &body[separator + 1..];
    selector == b"c"
        && !payload.is_empty()
        && payload != b"?"
        && payload.len() <= MAX_PAYLOAD
        && payload
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|part| part == needle)
}
fn terminator(bytes: &[u8]) -> Option<(usize, usize)> {
    for index in 0..bytes.len() {
        if bytes[index] == 7 {
            return Some((index, 1));
        }
        if bytes[index] == 27 && bytes.get(index + 1) == Some(&b'\\') {
            return Some((index, 2));
        }
    }
    None
}
fn suffix_prefix_len(bytes: &[u8], prefix: &[u8]) -> usize {
    (1..prefix.len())
        .rev()
        .find(|length| bytes.ends_with(&prefix[..*length]))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_fragmented_bel_and_st_sequences() {
        let mut parser = Osc52Parser::default();
        assert!(parser.feed(b"screen\x1b]5").is_empty());
        assert_eq!(
            parser.feed(b"2;c;aGVsbG8=\x07tail"),
            vec![b"\x1b]52;c;aGVsbG8=\x07".to_vec()]
        );
        assert_eq!(
            parser.feed(b"\x1b]52;c;eA==\x1b\\"),
            vec![b"\x1b]52;c;eA==\x1b\\".to_vec()]
        );
    }
    #[test]
    fn rejects_reads_and_other_control_sequences() {
        let mut parser = Osc52Parser::default();
        assert!(parser
            .feed(b"\x1b]52;c;?\x07\x1b]0;title\x07\x1b]52;p;eA==\x07")
            .is_empty());
    }
    #[test]
    fn oversized_fragment_resets_and_recovers() {
        let mut parser = Osc52Parser::default();
        let mut oversized = b"\x1b]52;c;".to_vec();
        oversized.extend([b'A'; MAX_PAYLOAD + 20]);
        assert!(parser.feed(&oversized).is_empty());
        assert!(parser.feed(b"\x1b]52;c;eA==\x1b").is_empty());
        assert_eq!(parser.feed(b"\\"), vec![b"\x1b]52;c;eA==\x1b\\".to_vec()]);
        parser.feed(b"\x1b]52;c;YWJj");
        parser.reset();
        assert!(parser.feed(b"ZA==\x07").is_empty());
    }
}
