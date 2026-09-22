//! The historical Windows probe's standard-input **byte** observer.
//!
//! The R1 diagnostic compares the candidate's console read boundary against the
//! one the successful historical probe used:
//!
//! ```text
//! let mut stdin = std::io::stdin().lock();
//! let mut buffer = [0_u8; 4096];
//! stdin.read(&mut buffer)
//! ```
//!
//! Emulating that loop by hand is what made the previous attempt inconclusive:
//! a hand-written `ReadConsoleW` loop has no demonstrated equivalent for the
//! standard library's request sizing, incomplete-UTF-8 buffering, partial
//! returns or unpaired-surrogate rejection, so a Windows 10 difference could
//! have come from the emulation rather than from the boundary under test.
//!
//! This module is therefore the loop itself, and it is compiled **twice from
//! these exact bytes**:
//!
//! * into this test binary, where the cases below drive it through a scripted
//!   [`Read`] and pin every boundary it can reach;
//! * into the Windows pane child, which
//!   [`super::windows_byte_child`] writes out verbatim and compiles with the
//!   workspace-pinned toolchain, feeding it `std::io::stdin().lock()`.
//!
//! Nothing here converts UTF-16, carries surrogates or touches a console: on
//! Windows the standard library already drains the console as UTF-16, buffers an
//! incomplete UTF-8 character across reads and rejects an unpaired surrogate
//! with [`std::io::ErrorKind::InvalidData`]. Re-implementing any of that is
//! exactly the manual emulation the finding rejects. The observer's own
//! responsibility is narrow and complete: read into a 4,096-byte buffer until
//! the expected count is reached, grow `out.part` as bytes arrive, refuse a
//! short, failed or overrun capture, and publish `out` only after an exact one.
//!
//! It is deliberately free of every crate item: the generated child compiles it
//! as a bare module of a `std`-only binary.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

/// The historical probe's output buffer. A single `read` can never yield more
/// than this many bytes, which is what bounds one observation.
pub(crate) const READ_BUFFER_BYTES: usize = 4096;

/// Every way an observation can end other than an exact capture.
///
/// Each variant carries the counts that locate it, so a red names the boundary
/// that fired instead of only reporting that bytes are missing.
#[derive(Debug)]
pub(crate) enum CaptureFailure {
    /// The partial capture file could not be created for this child.
    PartialUnavailable { path: String, error: String },
    /// Standard input ended before the expected byte count arrived.
    EndOfInput { received: usize, want: usize },
    /// A read failed. On a Windows console an unpaired surrogate arrives here.
    ReadFailed {
        received: usize,
        want: usize,
        error: String,
    },
    /// More bytes arrived than the capture expected.
    Overrun { received: usize, want: usize },
    /// The bytes that did arrive could not be recorded.
    PartialWriteFailed { received: usize, error: String },
    /// The exact capture could not be published atomically.
    PublicationFailed { path: String, error: String },
}

impl std::fmt::Display for CaptureFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PartialUnavailable { path, error } => write!(
                formatter,
                "the partial capture file {path} could not be created: {error}"
            ),
            Self::EndOfInput { received, want } => write!(
                formatter,
                "standard input ended after {received} of {want} bytes"
            ),
            Self::ReadFailed {
                received,
                want,
                error,
            } => write!(
                formatter,
                "standard input failed after {received} of {want} bytes: {error}"
            ),
            Self::Overrun { received, want } => write!(
                formatter,
                "standard input delivered {received} bytes where exactly {want} were expected"
            ),
            Self::PartialWriteFailed { received, error } => write!(
                formatter,
                "the partial capture could not be recorded after {received} bytes: {error}"
            ),
            Self::PublicationFailed { path, error } => write!(
                formatter,
                "the exact capture could not be published as {path}: {error}"
            ),
        }
    }
}

/// Reads exactly `want` bytes, recording each read into `partial` as it arrives.
///
/// The loop is the historical one: a fixed 4,096-byte buffer, one `read` per
/// iteration, and no interpretation of the bytes. A read of zero is end of
/// input, an error is reported with the count already captured, and a read that
/// carries the capture past `want` is an overrun rather than a success — the
/// historical probe silently kept those extra bytes.
pub(crate) fn observe_exact_bytes<R: Read, W: Write>(
    reader: &mut R,
    want: usize,
    partial: &mut W,
) -> Result<usize, CaptureFailure> {
    let mut buffer = [0_u8; READ_BUFFER_BYTES];
    let mut received = 0_usize;
    while received < want {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| CaptureFailure::ReadFailed {
                received,
                want,
                error: error.to_string(),
            })?;
        if read == 0 {
            return Err(CaptureFailure::EndOfInput { received, want });
        }
        // Recorded before the count moves, so `out.part` is never shorter than
        // what the harness is told arrived.
        write_partial(partial, &buffer[..read], received)?;
        received += read;
    }
    if received != want {
        return Err(CaptureFailure::Overrun { received, want });
    }
    Ok(received)
}

fn write_partial<W: Write>(
    partial: &mut W,
    bytes: &[u8],
    received: usize,
) -> Result<(), CaptureFailure> {
    partial
        .write_all(bytes)
        .and_then(|()| partial.flush())
        .map_err(|error| CaptureFailure::PartialWriteFailed {
            received,
            error: error.to_string(),
        })
}

/// Runs an observation against a slot: grow `out.part`, then publish `out`.
///
/// Publication is a rename of the completed partial file, so `out` exists only
/// after exactly `want` bytes were observed. Every failure leaves `out.part`
/// in place with the bytes that did arrive and never creates `out`.
pub(crate) fn capture_to_slot<R: Read>(
    reader: &mut R,
    want: usize,
    partial_path: &Path,
    out_path: &Path,
) -> Result<usize, CaptureFailure> {
    // `create_new`: a partial file left by another child must never be adopted
    // or truncated, because it would be reported as this child's capture.
    let mut partial =
        fs::File::create_new(partial_path).map_err(|error| CaptureFailure::PartialUnavailable {
            path: partial_path.display().to_string(),
            error: error.to_string(),
        })?;
    let received = observe_exact_bytes(reader, want, &mut partial)?;
    // Closed before the rename: Windows refuses to move a file that still has
    // a writable handle open in this process.
    drop(partial);
    fs::rename(partial_path, out_path).map_err(|error| CaptureFailure::PublicationFailed {
        path: out_path.display().to_string(),
        error: error.to_string(),
    })?;
    Ok(received)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// CR/LF, `β`, `😀`, an ESC-introduced sequence and a raw control byte —
    /// the payload shape the final-sink proofs send through the real sink.
    const RICH_PAYLOAD: &str = "alpha\r\nβ 😀 \u{2} \u{1b}[9;2u omega";

    /// One scripted standard-input behaviour.
    enum ReaderStep {
        /// Bytes to hand out, split across as many reads as the buffer forces.
        Deliver(Vec<u8>),
        /// A read error, which is how a Windows console reports an unpaired
        /// surrogate.
        Fail(std::io::Error),
    }

    /// A `Read` whose returns are scripted, so partial returns, split
    /// characters, end of input and read errors are all reachable here.
    struct ScriptedReader {
        steps: VecDeque<ReaderStep>,
        largest_request: usize,
        reads: usize,
    }

    impl ScriptedReader {
        fn new(steps: Vec<ReaderStep>) -> Self {
            Self {
                steps: steps.into(),
                largest_request: 0,
                reads: 0,
            }
        }

        /// Delivers `bytes` in fixed-size pieces, one read each.
        fn in_pieces(bytes: &[u8], piece: usize) -> Self {
            Self::new(
                bytes
                    .chunks(piece)
                    .map(|chunk| ReaderStep::Deliver(chunk.to_vec()))
                    .collect(),
            )
        }
    }

    impl Read for ScriptedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.largest_request = self.largest_request.max(buffer.len());
            self.reads += 1;
            match self.steps.front_mut() {
                // An exhausted script is end of input.
                None => Ok(0),
                Some(ReaderStep::Fail(_)) => match self.steps.pop_front() {
                    Some(ReaderStep::Fail(error)) => Err(error),
                    _ => unreachable!("the front step was just observed as a failure"),
                },
                Some(ReaderStep::Deliver(pending)) => {
                    let taken = buffer.len().min(pending.len());
                    buffer[..taken].copy_from_slice(&pending[..taken]);
                    pending.drain(..taken);
                    if pending.is_empty() {
                        self.steps.pop_front();
                    }
                    Ok(taken)
                }
            }
        }
    }

    /// A directory no other case in this process can collide with.
    fn scratch_directory(label: &str) -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let directory = std::env::temp_dir().join(format!(
            "rmux-byte-observer-{}-{}-{label}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).expect("create the scratch directory");
        directory
    }

    struct Slot {
        directory: PathBuf,
        partial: PathBuf,
        out: PathBuf,
    }

    impl Slot {
        fn new(label: &str) -> Self {
            let directory = scratch_directory(label);
            Self {
                partial: directory.join("out.part"),
                out: directory.join("out"),
                directory,
            }
        }

        fn capture(
            &self,
            reader: &mut ScriptedReader,
            want: usize,
        ) -> Result<usize, CaptureFailure> {
            capture_to_slot(reader, want, &self.partial, &self.out)
        }

        fn partial_bytes(&self) -> Vec<u8> {
            fs::read(&self.partial).unwrap_or_default()
        }
    }

    impl Drop for Slot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    /// The historical reader can never take more than 4,096 bytes from one
    /// call, which is what bounds a single observation.
    #[test]
    fn one_read_never_takes_more_than_the_historical_four_kibibyte_buffer() {
        let payload = vec![b'x'; READ_BUFFER_BYTES * 2 + 37];
        let slot = Slot::new("bounded-buffer");
        let mut reader = ScriptedReader::new(vec![ReaderStep::Deliver(payload.clone())]);

        let received = slot
            .capture(&mut reader, payload.len())
            .expect("the whole payload is available");

        assert_eq!(received, payload.len());
        assert_eq!(reader.largest_request, READ_BUFFER_BYTES);
        assert_eq!(
            reader.reads, 3,
            "4096 + 4096 + 37 is three reads of the historical buffer"
        );
        assert_eq!(fs::read(&slot.out).expect("published capture"), payload);
    }

    /// A console read returns what is available, not what was asked for.
    #[test]
    fn partial_returns_are_accumulated_until_the_exact_byte_count() {
        let payload = RICH_PAYLOAD.as_bytes();
        let slot = Slot::new("partial-returns");
        let mut reader = ScriptedReader::in_pieces(payload, 1);

        let received = slot.capture(&mut reader, payload.len()).expect("capture");

        assert_eq!(received, payload.len());
        assert_eq!(reader.reads, payload.len());
        assert_eq!(fs::read(&slot.out).expect("published capture"), payload);
    }

    /// A multi-byte character split between two reads must be reassembled
    /// byte-exactly, including a supplementary character's four bytes.
    #[test]
    fn characters_split_between_reads_are_reassembled_byte_exactly() {
        let payload = RICH_PAYLOAD.as_bytes();
        let emoji = RICH_PAYLOAD.find('😀').expect("the payload carries 😀");
        // Every interior split of the supplementary character, plus a split
        // inside `β`, plus one that separates CR from LF.
        let splits = [
            RICH_PAYLOAD.find('\r').expect("CR") + 1,
            RICH_PAYLOAD.find('β').expect("β") + 1,
            emoji + 1,
            emoji + 2,
            emoji + 3,
        ];
        for split in splits {
            let slot = Slot::new(&format!("split-at-{split}"));
            let mut reader = ScriptedReader::new(vec![
                ReaderStep::Deliver(payload[..split].to_vec()),
                ReaderStep::Deliver(payload[split..].to_vec()),
            ]);

            slot.capture(&mut reader, payload.len())
                .unwrap_or_else(|failure| panic!("split at {split} must still capture: {failure}"));

            let published = fs::read(&slot.out).expect("published capture");
            assert_eq!(published, payload, "split at {split} lost bytes");
            assert_eq!(
                String::from_utf8(published).expect("valid UTF-8"),
                RICH_PAYLOAD,
                "split at {split} corrupted a character"
            );
        }
    }

    /// An unpaired surrogate is how a Windows console rejects input it cannot
    /// encode. It must arrive as an attributable read error with the bytes that
    /// did reach the child preserved, not as a bare timeout.
    #[test]
    fn an_unpaired_surrogate_read_error_is_attributed_and_preserves_the_partial() {
        let slot = Slot::new("unpaired-surrogate");
        let mut reader = ScriptedReader::new(vec![
            ReaderStep::Deliver(b"head".to_vec()),
            ReaderStep::Fail(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Windows stdin in console mode does not support non-UTF-16 input; \
                 encountered unpaired surrogate",
            )),
        ]);

        let failure = slot
            .capture(&mut reader, 32)
            .expect_err("an unpaired surrogate must fail the capture");

        let rendered = failure.to_string();
        assert!(
            matches!(
                failure,
                CaptureFailure::ReadFailed {
                    received: 4,
                    want: 32,
                    ..
                }
            ),
            "unexpected failure: {rendered}"
        );
        assert!(
            rendered.contains("unpaired surrogate"),
            "the console's own reason must survive: {rendered}"
        );
        assert_eq!(slot.partial_bytes(), b"head", "the partial must be kept");
        assert!(
            !slot.out.exists(),
            "a failed capture must not publish `out`"
        );
    }

    /// End of input before the expected count is a different diagnosis from a
    /// read error and must name both counts.
    #[test]
    fn end_of_input_before_the_expected_count_names_the_missing_bytes() {
        let slot = Slot::new("short-eof");
        let mut reader = ScriptedReader::new(vec![ReaderStep::Deliver(b"only-four".to_vec())]);

        let failure = slot
            .capture(&mut reader, 64)
            .expect_err("a short capture must fail");

        assert!(
            matches!(
                failure,
                CaptureFailure::EndOfInput {
                    received: 9,
                    want: 64
                }
            ),
            "unexpected failure: {failure}"
        );
        assert_eq!(
            failure.to_string(),
            "standard input ended after 9 of 64 bytes"
        );
        assert_eq!(slot.partial_bytes(), b"only-four");
        assert!(!slot.out.exists(), "a short capture must not publish `out`");
    }

    /// A read error before any byte arrives still reports which boundary fired.
    #[test]
    fn a_read_error_reports_the_count_already_captured() {
        let slot = Slot::new("read-error");
        let mut reader = ScriptedReader::new(vec![ReaderStep::Fail(std::io::Error::new(
            std::io::ErrorKind::BrokenPipe,
            "the pipe has been ended",
        ))]);

        let failure = slot
            .capture(&mut reader, 12)
            .expect_err("a failed read must fail the capture");

        assert_eq!(
            failure.to_string(),
            "standard input failed after 0 of 12 bytes: the pipe has been ended"
        );
        assert!(slot.partial.exists(), "the empty partial must be kept");
        assert!(
            !slot.out.exists(),
            "a failed capture must not publish `out`"
        );
    }

    /// Extra input is a defect, not a success: the historical probe kept the
    /// overrun bytes and published them as a complete capture.
    #[test]
    fn extra_input_beyond_the_expected_count_is_reported_as_an_overrun() {
        let slot = Slot::new("overrun");
        let mut reader =
            ScriptedReader::new(vec![ReaderStep::Deliver(b"exactly-ten-and-more".to_vec())]);

        let failure = slot
            .capture(&mut reader, 10)
            .expect_err("extra input must not be accepted");

        assert_eq!(
            failure.to_string(),
            "standard input delivered 20 bytes where exactly 10 were expected"
        );
        assert_eq!(
            slot.partial_bytes(),
            b"exactly-ten-and-more",
            "the overrun bytes are the evidence"
        );
        assert!(!slot.out.exists(), "an overrun must not publish `out`");
    }

    /// `out` is the completion signal the harness polls, so it must appear only
    /// once, whole, and only after the exact count.
    #[test]
    fn out_is_published_atomically_and_only_after_an_exact_capture() {
        let payload = RICH_PAYLOAD.as_bytes();
        let slot = Slot::new("atomic-publication");
        let mut reader = ScriptedReader::in_pieces(payload, 7);

        slot.capture(&mut reader, payload.len()).expect("capture");

        assert_eq!(fs::read(&slot.out).expect("published capture"), payload);
        assert!(
            !slot.partial.exists(),
            "publication renames the partial rather than copying it"
        );
    }

    /// A partial file from an earlier child must never be adopted or truncated.
    #[test]
    fn a_partial_left_by_an_earlier_child_is_refused() {
        let slot = Slot::new("stale-partial");
        fs::write(&slot.partial, b"an earlier child").expect("stage the stale partial");
        let mut reader = ScriptedReader::new(vec![ReaderStep::Deliver(b"fresh".to_vec())]);

        let failure = slot
            .capture(&mut reader, 5)
            .expect_err("an existing partial must be refused");

        assert!(
            matches!(failure, CaptureFailure::PartialUnavailable { .. }),
            "unexpected failure: {failure}"
        );
        assert_eq!(
            slot.partial_bytes(),
            b"an earlier child",
            "refusing must not destroy the earlier evidence"
        );
    }
}
