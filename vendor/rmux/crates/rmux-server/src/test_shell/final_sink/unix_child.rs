//! The Unix final-sink pane child, and the protocol it owes the harness.
//!
//! The previous script was a straight line with no checked status:
//!
//! ```sh
//! stty raw -echo
//! : > ready
//! dd bs=1 count=N of=out.part 2>/dev/null
//! mv out.part out
//! ```
//!
//! `dd bs=1 count=N` treats end of input before `N` as normal end of input, not
//! as an error, so a short capture left a short `out.part` and the
//! unconditional `mv` published it as `out` — the slot protocol's word for a
//! *complete* capture. The harness then reported "wrong bytes" with
//! `child error: none`, which reads like a sink that delivered the wrong thing
//! rather than an input that ended early. A failed `stty` was equally invisible:
//! readiness was announced anyway, so the capture could be taken from a cooked
//! terminal that rewrites CR/LF and eats the paste's leading `ESC`. A failed
//! `mv` simply left no `out`, and the run ended at a timeout boundary that
//! never named the command that failed.
//!
//! The corrected script checks every step separately — raw setup, the
//! announcement, readiness, the read, the exact size and the publication — and
//! each failure writes an attributable `error`, keeps whatever `out.part`
//! holds, and still parks and acknowledges teardown through `done`. `out` is
//! created only by renaming a partial file that already holds exactly `N`
//! bytes.
//!
//! The generator is platform-neutral so the shape of that protocol is checked
//! wherever this crate's tests run. Executing the child is a separate matter:
//! the `#[cfg(unix)]` cases at the bottom run `/bin/sh` for real, and they are
//! the ones that carry the authority.

/// The real child's raw-mode setup. A regression pins that the shipped script
/// uses exactly this, so the substitutable seam below cannot leak into it.
const RAW_SETUP_COMMAND: &str = "stty raw -echo 2>/dev/null";

/// Runs the corrected capture protocol in the platform's own shell.
#[cfg(unix)]
pub(super) fn pane_command(slot: &super::FinalSinkSlot) -> Vec<String> {
    vec!["/bin/sh".to_owned(), "-c".to_owned(), script(slot)]
}

/// The script the real child runs.
pub(super) fn script(slot: &super::FinalSinkSlot) -> String {
    script_with_raw_setup(slot, RAW_SETUP_COMMAND)
}

/// The same script with a substitutable raw-mode step.
///
/// `stty raw -echo` needs a terminal, so a regression that drives the child
/// through a pipe cannot reach the read, size and publication boundaries
/// without replacing it. Only the tests below pass anything but
/// [`RAW_SETUP_COMMAND`].
pub(super) fn script_with_raw_setup(slot: &super::FinalSinkSlot, raw_setup: &str) -> String {
    let quote = crate::test_shell::command_quote;
    let announce = if slot.bracket_aware {
        r"printf '\033[?2004h'"
    } else {
        ":"
    };
    format!(
        "set -u\n\
         captured() {{\n\
         if [ -e {partial} ]; then\n\
         printf '%s' \"$(($(wc -c < {partial})))\"\n\
         else\n\
         printf '0'\n\
         fi\n\
         }}\n\
         park() {{\n\
         i=0\n\
         while [ \"$i\" -lt {ticks} ] && [ ! -e {stop} ]; do\n\
         sleep 0.05\n\
         i=$((i+1))\n\
         done\n\
         }}\n\
         fail() {{\n\
         printf '%s' \"$1\" > {error}\n\
         park\n\
         printf '' > {done}\n\
         exit 1\n\
         }}\n\
         {raw_setup} || fail 'raw mode could not be established: stty raw -echo failed'\n\
         {announce} || fail 'the capability announcement could not be written'\n\
         printf '' > {ready} || fail 'readiness could not be signalled'\n\
         dd bs=1 count={count} of={partial} 2>/dev/null || \
         fail \"the capture read failed after $(captured) of {count} bytes\"\n\
         [ \"$(captured)\" -eq {count} ] || \
         fail \"standard input ended after $(captured) of {count} bytes\"\n\
         mv {partial} {out} || fail 'the exact capture could not be published'\n\
         park\n\
         printf '' > {done}\n",
        ready = quote(&slot.path(super::READY_FILE)),
        partial = quote(&slot.path(super::OUT_PARTIAL_FILE)),
        out = quote(&slot.path(super::OUT_FILE)),
        error = quote(&slot.path(super::ERROR_FILE)),
        stop = quote(&slot.path(super::STOP_FILE)),
        done = quote(&slot.path(super::DONE_FILE)),
        count = slot.expected.len(),
        ticks = super::CHILD_PARK_SECONDS * 20,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_shell::final_sink::{
        FinalSinkSlot, DONE_FILE, ERROR_FILE, OUT_FILE, OUT_PARTIAL_FILE, READY_FILE, STOP_FILE,
    };

    /// A slot file exactly as it appears in the script.
    ///
    /// The quoted form is what distinguishes `'…/out'` from `'…/out.part'`, of
    /// which the first is a prefix.
    fn quoted(slot: &FinalSinkSlot, file: &str) -> String {
        crate::test_shell::command_quote(&slot.path(file))
    }

    /// The one line that runs `needle`, so an assertion cannot accidentally
    /// match the same text inside the failure path.
    fn line_running<'script>(script: &'script str, needle: &str) -> &'script str {
        let mut matches = script.lines().filter(|line| line.contains(needle));
        let line = matches
            .next()
            .unwrap_or_else(|| panic!("the script must run {needle:?}:\n{script}"));
        assert!(
            matches.next().is_none(),
            "{needle:?} must appear on exactly one line:\n{script}"
        );
        line
    }

    fn assert_guarded(script: &str, needle: &str, reason: &str) {
        let line = line_running(script, needle);
        assert!(line.contains("|| fail"), "{needle:?} is unchecked:\n{line}");
        assert!(
            line.contains(reason),
            "the {needle:?} guard must name {reason:?}:\n{line}"
        );
    }

    /// The finding itself: the old script checked nothing, so any of these
    /// steps could fail while the child carried on to `done`.
    #[test]
    fn raw_setup_the_read_the_exact_size_and_publication_are_each_checked_separately() {
        let slot = FinalSinkSlot::new("unix-guards", b"payload", true);
        let script = script(&slot);

        assert_guarded(
            &script,
            "stty raw -echo",
            "raw mode could not be established",
        );
        assert_guarded(
            &script,
            r"printf '\033[?2004h'",
            "the capability announcement could not be written",
        );
        assert_guarded(
            &script,
            &quoted(&slot, READY_FILE),
            "readiness could not be signalled",
        );
        assert_guarded(&script, "dd bs=1 count=7", "the capture read failed after");
        assert_guarded(
            &script,
            r#"[ "$(captured)" -eq 7 ]"#,
            "standard input ended after",
        );
        assert_guarded(
            &script,
            &quoted(&slot, OUT_FILE),
            "the exact capture could not be published",
        );
    }

    /// Order is the protocol. Readiness before raw mode lets the capture be
    /// taken from a cooked terminal; publication before the size check
    /// publishes a short capture as a complete one.
    #[test]
    fn setup_precedes_readiness_and_the_size_check_precedes_publication() {
        let slot = FinalSinkSlot::new("unix-order", b"0123456789", false);
        let script = script(&slot);
        let at = |needle: &str| {
            script
                .find(line_running(&script, needle))
                .expect("the line came from this script")
        };

        let raw_setup = at("stty raw -echo");
        let readiness = at(&quoted(&slot, READY_FILE));
        let read = at("dd bs=1 count=10");
        let size_check = at(r#"[ "$(captured)" -eq 10 ]"#);
        let publication = at(&quoted(&slot, OUT_FILE));

        assert!(
            raw_setup < readiness,
            "raw mode precedes readiness:\n{script}"
        );
        assert!(readiness < read, "readiness precedes the read:\n{script}");
        assert!(
            read < size_check,
            "the read precedes its size check:\n{script}"
        );
        assert!(
            size_check < publication,
            "`out` must never be published before the exact size is proved:\n{script}"
        );
    }

    /// `out` is the harness's word for a complete capture, so exactly one
    /// command may create it and it must be the rename of an exact partial.
    #[test]
    fn out_is_created_only_by_renaming_the_partial() {
        let slot = FinalSinkSlot::new("unix-publication", b"abc", true);
        let script = script(&slot);

        let publication = line_running(&script, &quoted(&slot, OUT_FILE));
        assert!(
            publication.starts_with(&format!(
                "mv {} {}",
                quoted(&slot, OUT_PARTIAL_FILE),
                quoted(&slot, OUT_FILE)
            )),
            "`out` may only be created by renaming the partial:\n{publication}"
        );
    }

    /// A failure must keep the evidence and still finish teardown: the harness
    /// reads `out.part` to say what did arrive, and waits for `done`.
    #[test]
    fn every_failure_keeps_the_partial_capture_and_still_acknowledges_teardown() {
        let slot = FinalSinkSlot::new("unix-failure-path", b"abc", true);
        let script = script(&slot);

        let failure_path = script
            .split_once("fail() {\n")
            .expect("the script defines a failure path")
            .1
            .split_once("\n}\n")
            .expect("the failure path is a shell function")
            .0;

        assert!(
            failure_path.contains(&quoted(&slot, ERROR_FILE)),
            "a failure must write `error`:\n{failure_path}"
        );
        assert!(
            failure_path.contains("\npark\n"),
            "a failure must still park so the pane stays resolvable:\n{failure_path}"
        );
        assert!(
            failure_path.contains(&quoted(&slot, DONE_FILE)),
            "teardown must be acknowledged even when the capture failed:\n{failure_path}"
        );
        assert!(
            !failure_path.contains(&quoted(&slot, OUT_FILE)),
            "a failure must never publish `out`:\n{failure_path}"
        );
        assert!(
            !script.contains(&format!("rm {}", quoted(&slot, OUT_PARTIAL_FILE))),
            "the partial capture is the evidence and is never removed:\n{script}"
        );
    }

    /// The substitutable raw-mode step is a regression seam and must never be
    /// what the real child runs.
    #[test]
    fn the_real_child_always_establishes_raw_mode_with_stty() {
        let slot = FinalSinkSlot::new("unix-raw-setup", b"abc", true);
        assert_eq!(RAW_SETUP_COMMAND, "stty raw -echo 2>/dev/null");
        assert!(script(&slot).starts_with("set -u\n"));
        assert!(script(&slot).contains(&format!("\n{RAW_SETUP_COMMAND} || fail ")));
    }

    /// Teardown is signalled separately from capture success: both paths park
    /// on the same `stop` file and both acknowledge with `done`.
    #[test]
    fn teardown_is_signalled_by_stop_on_both_paths() {
        let slot = FinalSinkSlot::new("unix-teardown", b"abc", false);
        let script = script(&slot);

        assert!(line_running(&script, &quoted(&slot, STOP_FILE)).contains("! -e"));
        assert_eq!(
            script.matches("\npark\n").count(),
            2,
            "both the failure path and the success path park:\n{script}"
        );
        assert_eq!(
            script.matches(&quoted(&slot, DONE_FILE)).count(),
            2,
            "both paths acknowledge teardown:\n{script}"
        );
    }

    /// Slot paths reach the shell as one argument whatever they contain.
    #[test]
    fn slot_paths_are_quoted_for_the_shell() {
        assert_eq!(crate::test_shell::command_quote("a'b"), r"'a'\''b'");
    }

    // -----------------------------------------------------------------------
    // Real `/bin/sh` execution.
    //
    // These carry the authority for this correction and cannot run on Windows,
    // so this attempt does not claim them; the targeted Unix job does. The
    // read-only slot guard lives here too: it is Unix permission behaviour, and
    // the case that needs it is one of these.
    // -----------------------------------------------------------------------

    #[cfg(unix)]
    mod execution {
        use super::*;
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Command, Stdio};

        /// What one real `/bin/sh` run left behind.
        ///
        /// Only [`launch`] builds one, and only once `spawn` has returned a
        /// live process, so a caller holding a `ChildRun` has already proved
        /// that the child existed: a helper that failed while preparing the
        /// slot can never produce one, and its absence is no longer
        /// indistinguishable from a child that ran and said nothing.
        ///
        /// `diagnostic` is the shell's own account of the steps it could not
        /// perform. It is the only channel left when the slot the child was
        /// given is not writable, because `error` lives in that same slot.
        struct ChildRun {
            process_id: u32,
            status: std::process::ExitStatus,
            diagnostic: String,
        }

        impl ChildRun {
            /// The process the script actually ran in.
            fn launched_process_id(&self) -> u32 {
                self.process_id
            }
        }

        impl std::fmt::Display for ChildRun {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(
                    formatter,
                    "`/bin/sh` process {} finished with {}, reporting: {}",
                    self.process_id,
                    self.status,
                    if self.diagnostic.trim().is_empty() {
                        "nothing"
                    } else {
                        self.diagnostic.trim_end()
                    }
                )
            }
        }

        /// Stages the harness-owned `stop` so the child's park ends at once.
        ///
        /// Deliberately separate from [`launch`]: this is the *harness* writing
        /// into the slot directory, and the unwritable-slot case has to stage it
        /// while that directory is still writable. Staging it inside the runner
        /// made this the first write attempted after the mode change, so it
        /// failed with `EACCES` and `/bin/sh` was never spawned at all.
        fn pre_signal_stop(slot: &FinalSinkSlot) {
            std::fs::write(slot.directory.join(STOP_FILE), b"1").expect("pre-signal `stop`");
        }

        /// Spawns the script with `input` on standard input and waits for it.
        ///
        /// A pipe is not a terminal, so cases that need to reach the read
        /// replace the raw-mode step; the case that exercises raw-mode failure
        /// keeps the real one.
        fn launch(slot: &FinalSinkSlot, input: &[u8], raw_setup: &str) -> ChildRun {
            let mut child = Command::new("/bin/sh")
                .arg("-c")
                .arg(script_with_raw_setup(slot, raw_setup))
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn the final-sink child script");
            let process_id = child.id();
            let offered = child
                .stdin
                .take()
                .expect("the child has a standard input")
                .write_all(input);
            // A child whose setup already failed stops reading and may be gone
            // before the payload is offered, which is precisely what the failure
            // cases below are about. A closed pipe is therefore an outcome to
            // report through the exit status and the diagnostic, not a harness
            // failure; anything else still is one.
            if let Err(error) = offered {
                assert_eq!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe,
                    "the payload could not be written to the child: {error}"
                );
            }
            let finished = child
                .wait_with_output()
                .expect("wait for the final-sink child script");
            ChildRun {
                process_id,
                status: finished.status,
                diagnostic: String::from_utf8_lossy(&finished.stderr).into_owned(),
            }
        }

        /// Stages `stop` and then runs the child, which is what every case whose
        /// slot the harness can still write to needs.
        fn run(slot: &FinalSinkSlot, input: &[u8], raw_setup: &str) -> ChildRun {
            pre_signal_stop(slot);
            launch(slot, input, raw_setup)
        }

        /// Readable and traversable, but nothing may be created in it.
        const READ_ONLY_SLOT_MODE: u32 = 0o555;

        /// Makes a slot directory read-only for as long as it is held, then
        /// restores exactly the mode it found.
        ///
        /// The mode is read rather than assumed: restoring a hard-coded `0o755`
        /// would widen a slot created under a stricter umask, and would pass its
        /// own test for the wrong reason.
        ///
        /// Restoration belongs to `Drop` because an assertion that fails while
        /// the slot is read-only must still unwind through it; the statements
        /// this replaces sat after the run and were simply skipped. Holding a
        /// borrow of the slot is what orders the two teardowns: the compiler
        /// will not let a [`FinalSinkSlot`] be dropped while a guard borrowing
        /// it is alive, so the mode is always restored before the slot's own
        /// cleanup, which has to write to that directory to remove it.
        struct ReadOnlySlot<'slot> {
            slot: &'slot FinalSinkSlot,
            original: std::fs::Permissions,
        }

        impl<'slot> ReadOnlySlot<'slot> {
            fn new(slot: &'slot FinalSinkSlot) -> Self {
                let original = slot_permissions(slot);
                let mut read_only = original.clone();
                read_only.set_mode(READ_ONLY_SLOT_MODE);
                std::fs::set_permissions(&slot.directory, read_only)
                    .expect("make the slot read-only");
                Self { slot, original }
            }
        }

        impl Drop for ReadOnlySlot<'_> {
            fn drop(&mut self) {
                if let Err(error) =
                    std::fs::set_permissions(&self.slot.directory, self.original.clone())
                {
                    let report = format!(
                        "the final-sink slot {} could not be restored to mode {:04o}: {error}",
                        self.slot.directory.display(),
                        self.original.mode() & 0o7777,
                    );
                    // Panicking while already unwinding aborts the process,
                    // which would destroy the failure being reported.
                    if std::thread::panicking() {
                        eprintln!("{report}");
                    } else {
                        panic!("{report}");
                    }
                }
            }
        }

        fn slot_permissions(slot: &FinalSinkSlot) -> std::fs::Permissions {
            std::fs::metadata(&slot.directory)
                .expect("the slot exists")
                .permissions()
        }

        /// The slot directory's permission bits, without the file-type bits a
        /// raw `mode()` also carries.
        fn slot_mode(slot: &FinalSinkSlot) -> u32 {
            slot_permissions(slot).mode() & 0o7777
        }

        fn set_slot_mode(slot: &FinalSinkSlot, mode: u32) {
            let mut permissions = slot_permissions(slot);
            permissions.set_mode(mode);
            std::fs::set_permissions(&slot.directory, permissions).expect("set the slot mode");
        }

        fn slot_file(slot: &FinalSinkSlot, file: &str) -> Option<Vec<u8>> {
            std::fs::read(slot.directory.join(file)).ok()
        }

        #[test]
        fn an_exact_capture_is_published_and_teardown_is_acknowledged() {
            let payload = "\u{1b}[200~alpha\r\nβ 😀\u{1b}[201~".as_bytes();
            let slot = FinalSinkSlot::new("unix-exact", payload, true);

            let child = run(&slot, payload, "true");

            assert!(
                child.status.success(),
                "an exact capture must succeed: {child}"
            );
            assert_eq!(
                slot_file(&slot, OUT_FILE).as_deref(),
                Some(payload),
                "the published capture must be byte-exact"
            );
            assert!(
                slot_file(&slot, OUT_PARTIAL_FILE).is_none(),
                "publication renames the partial rather than copying it"
            );
            assert!(slot_file(&slot, ERROR_FILE).is_none());
            assert!(slot_file(&slot, DONE_FILE).is_some());
        }

        /// The exact defect: `dd` exits successfully on a short read, so only
        /// the size check can stop a short capture from becoming `out`.
        #[test]
        fn end_of_input_before_the_expected_count_never_publishes_out() {
            let slot = FinalSinkSlot::new("unix-short-eof", b"0123456789", false);

            let child = run(&slot, b"01234", "true");

            assert_eq!(
                child.status.code(),
                Some(1),
                "a short capture must fail: {child}"
            );
            assert_eq!(
                slot_file(&slot, ERROR_FILE)
                    .map(|reason| String::from_utf8(reason).expect("the reason is text")),
                Some("standard input ended after 5 of 10 bytes".to_owned())
            );
            assert!(
                slot_file(&slot, OUT_FILE).is_none(),
                "a short capture is not a complete capture"
            );
            assert_eq!(
                slot_file(&slot, OUT_PARTIAL_FILE).as_deref(),
                Some(&b"01234"[..]),
                "the bytes that did arrive are the evidence"
            );
            assert!(slot_file(&slot, DONE_FILE).is_some());
        }

        #[test]
        fn a_failed_raw_mode_never_signals_readiness() {
            let slot = FinalSinkSlot::new("unix-raw-failure", b"abc", true);

            // The real `stty raw -echo`, against a pipe: it cannot succeed.
            let child = run(&slot, b"abc", RAW_SETUP_COMMAND);

            assert_eq!(
                child.status.code(),
                Some(1),
                "a failed setup must fail the child: {child}"
            );
            let reported = String::from_utf8(
                slot_file(&slot, ERROR_FILE).expect("a failed setup must write `error`"),
            )
            .expect("the reason is text");
            assert!(
                reported.contains("raw mode could not be established"),
                "unexpected reason: {reported}"
            );
            assert!(
                slot_file(&slot, READY_FILE).is_none(),
                "readiness must never be announced from a cooked terminal"
            );
            assert!(slot_file(&slot, OUT_FILE).is_none());
            assert!(slot_file(&slot, DONE_FILE).is_some());
        }

        /// A slot the child cannot write is a setup failure, not a silent
        /// readiness signal followed by a capture timeout.
        ///
        /// The harness's own `stop` is staged first, while the slot is still
        /// writable. It used to be staged by the runner, after the mode change,
        /// so the harness's write was the one that hit `EACCES`: `/bin/sh` was
        /// never spawned and the child-side failure this case exists for was
        /// never reached. The child is therefore launched directly here, and
        /// what it reports is read from the shell's own diagnostics — `error`
        /// lives in the very slot it cannot write.
        #[test]
        fn a_slot_it_cannot_write_is_reported_rather_than_silently_skipped() {
            let slot = FinalSinkSlot::new("unix-unwritable", b"abc", false);
            pre_signal_stop(&slot);
            let original_mode = slot_mode(&slot);

            let read_only = ReadOnlySlot::new(&slot);
            let child = launch(&slot, b"abc", "true");

            // The Unix job's evidence for this case is that a real child ran
            // and said why it could not go on, so the witness is retained in
            // the output and not only asserted on.
            println!("unwritable slot: {child}");
            assert_ne!(
                child.launched_process_id(),
                std::process::id(),
                "the script must have run in a real child process: {child}"
            );
            assert_eq!(
                child.status.code(),
                Some(1),
                "an unwritable slot must fail the child: {child}"
            );
            assert!(
                child.diagnostic.contains(&slot.path(READY_FILE)),
                "the child must have reached the readiness write and been refused: {child}"
            );
            assert!(
                child.diagnostic.contains(&slot.path(ERROR_FILE)),
                "the child must have run its failure path: {child}"
            );
            assert!(
                slot_file(&slot, READY_FILE).is_none(),
                "readiness must not be claimed when it could not be written"
            );
            assert!(
                slot_file(&slot, ERROR_FILE).is_none(),
                "an unwritable slot cannot even hold the child's own reason, \
                 which is why the shell's diagnostic is the channel here"
            );
            assert!(slot_file(&slot, OUT_FILE).is_none());

            drop(read_only);

            assert_eq!(
                slot_mode(&slot),
                original_mode,
                "the case must leave the slot exactly as it found it"
            );
        }

        /// The guard restores the mode it found. A hard-coded `0o755` would
        /// widen a slot created under a stricter umask, and no assertion in the
        /// case above would notice.
        #[test]
        fn a_read_only_slot_is_restored_to_exactly_the_mode_it_had() {
            let slot = FinalSinkSlot::new("unix-restore-exact", b"abc", false);
            // Deliberately not `0o755`: restoring a constant would pass here.
            set_slot_mode(&slot, 0o700);

            let read_only = ReadOnlySlot::new(&slot);
            assert_eq!(
                slot_mode(&slot),
                READ_ONLY_SLOT_MODE,
                "the guard must make the slot read-only"
            );
            drop(read_only);

            assert_eq!(slot_mode(&slot), 0o700, "exactly the original mode returns");
        }

        /// Restoration is owned by `Drop`, so a failing assertion between the
        /// mode change and the end of the case still leaves the slot as it was.
        /// The statements this replaces ran after the child and were skipped by
        /// the unwind, leaving a read-only directory behind.
        #[test]
        fn a_panic_while_the_slot_is_read_only_still_restores_its_mode() {
            let slot = FinalSinkSlot::new("unix-restore-unwind", b"abc", false);
            set_slot_mode(&slot, 0o700);

            let unwound: std::thread::Result<()> =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _read_only = ReadOnlySlot::new(&slot);
                    assert_eq!(slot_mode(&slot), READ_ONLY_SLOT_MODE);
                    panic!("deliberate: the case fails while the slot is read-only");
                }));

            assert!(unwound.is_err(), "the deliberate panic must have unwound");
            assert_eq!(
                slot_mode(&slot),
                0o700,
                "an unwind must restore the exact mode rather than skip restoration"
            );
        }
    }
}
