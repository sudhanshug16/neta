//! GNU `screen` support in the public benchmark pipeline.
//!
//! `screen` is the third comparator the benchmark page can publish, and it is
//! the one whose command surface least resembles tmux: it reports its version
//! through a failing exit status, lists sessions through a failing exit status,
//! captures with `hardcopy` instead of `capture-pane`, and has no equivalent at
//! all for splits, resizes or per-pane listing. Each of those is a way for the
//! adapter to silently publish nothing, publish "available" instead of a
//! version, or publish an estimate. These specs pin the observable contract of
//! the adapter, of the absent-tool omission rule, and of the rendered ordering,
//! labels and comparator band.
//!
//! Most of this is deterministic: the `screen` executable is a stub whose exit
//! statuses reproduce GNU screen's, so the specs run on hosts that have no
//! `screen` installed. They prove plumbing and contracts, never timings.
//!
//! Two cases cannot be proved that way, because a stub never execs the payload
//! and never enforces screen's own session-name length: how the measured
//! program reaches screen, and whether the scrollback row really captures its
//! 10,000 lines. Those run against the installed binary and are skipped, not
//! faked, on a host whose screen cannot express them -- which includes a host
//! with no screen at all, and one whose screen predates the surface they
//! measure.

#[path = "support/python3.rs"]
mod python3;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::{SystemTime, UNIX_EPOCH};

const SCREEN_BANNER: &str = "Screen version 4.09.01 (GNU) 20-Aug-23";

/// The oldest `screen` that can express the two rows the native cases measure.
///
/// `-Q`, which `list_windows_20` needs to read a command's answer back, arrived
/// in screen 4.1.0. Apple still ships 4.00.03 (FAU, 2006) as `/usr/bin/screen`,
/// which rejects `-Q` as an unknown option and whose detached
/// `hardcopy <file>` writes an empty file instead of the window buffer, so the
/// scrollback row never observes its own payload either. A host can therefore
/// have `screen` on `PATH` and still express neither row: presence is not the
/// requirement, this surface is.
#[cfg(unix)]
const MINIMUM_SCREEN_SURFACE: (u32, u32) = (4, 1);

/// The eight operations GNU screen can express. Splits, resizes and per-pane
/// listing have no strict equivalent and must stay absent.
const SCREEN_OPERATIONS: [&str; 8] = [
    "capture_pane_200x50_scrollback_10k",
    "capture_pane_80x24",
    "kill_session",
    "list_sessions_default",
    "list_windows_20",
    "new_session_cold_sh",
    "new_window_detached_sh",
    "send_keys_detached_round_trip",
];

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn temp_dir(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("rmux-{label}-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&path).expect("create temp directory");
    path
}

fn describe(label: &str, output: &Output) -> String {
    format!(
        "{label} exited with {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    )
}

/// Run a Python driver against the benchmark sources from the repository root.
fn run_driver(source: &str) -> Output {
    python3::command()
        .args(["-c", source])
        .current_dir(repo_root())
        .output()
        .expect("failed to run the benchmark driver")
}

fn driver_json(source: &str) -> serde_json::Value {
    let output = run_driver(source);
    assert!(output.status.success(), "{}", describe("driver", &output));
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "driver did not print JSON: {error}\n{}",
            describe("driver", &output)
        )
    })
}

const LOAD_BENCH: &str = "\
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('bench_unix', 'scripts/bench/bench_unix.py')
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)
";

const LOAD_RENDER: &str = "\
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('render', 'scripts/bench/render.py')
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)
";

/// A stand-in for GNU screen that reproduces the exit statuses that matter:
/// `-v` prints its banner and fails, `-ls` prints the listing and fails, and
/// every session command succeeds.
fn write_screen_stub(directory: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let path = directory.join("screen.cmd");
        fs::write(
            &path,
            format!(
                "@echo off\r\n\
                 if \"%~1\"==\"-v\" goto version\r\n\
                 if \"%~1\"==\"-ls\" goto listing\r\n\
                 exit /b 0\r\n\
                 :version\r\n\
                 echo {SCREEN_BANNER}\r\n\
                 exit /b 1\r\n\
                 :listing\r\n\
                 echo There is a screen on:\r\n\
                 exit /b 9\r\n"
            ),
        )
        .expect("write screen stub");
        path
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("screen");
        fs::write(
            &path,
            format!(
                "#!/bin/sh\n\
                 case \"$1\" in\n\
                 -v) echo '{SCREEN_BANNER}'; exit 1 ;;\n\
                 -ls) echo 'There is a screen on:'; exit 9 ;;\n\
                 esac\n\
                 exit 0\n"
            ),
        )
        .expect("write screen stub");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .expect("mark stub executable");
        path
    }
}

/// A stand-in for GNU screen whose sessions start but whose control commands
/// fail, which is how a capture operation reports a failure that quotes the
/// private temporary file it was capturing into.
fn write_capture_failing_stub(directory: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let path = directory.join("screen.cmd");
        fs::write(
            &path,
            format!(
                "@echo off\r\n\
                 if \"%~1\"==\"-v\" goto version\r\n\
                 if \"%~1\"==\"-dmS\" exit /b 0\r\n\
                 exit /b 1\r\n\
                 :version\r\n\
                 echo {SCREEN_BANNER}\r\n\
                 exit /b 1\r\n"
            ),
        )
        .expect("write failing screen stub");
        path
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("screen");
        fs::write(
            &path,
            format!(
                "#!/bin/sh\n\
                 case \"$1\" in\n\
                 -v) echo '{SCREEN_BANNER}'; exit 1 ;;\n\
                 -dmS) exit 0 ;;\n\
                 esac\n\
                 exit 1\n"
            ),
        )
        .expect("write failing screen stub");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .expect("mark stub executable");
        path
    }
}

/// The real GNU screen on this host, when it has one. GNU screen has no native
/// Windows build, so these cases are Unix-only and skip rather than pretend.
#[cfg(unix)]
/// The installed `screen`, or why these native cases cannot run on this host.
fn real_screen() -> Result<PathBuf, String> {
    let paths = std::env::var_os("PATH").ok_or("PATH is unset")?;
    let screen = std::env::split_paths(&paths)
        .map(|directory| directory.join("screen"))
        .find(|candidate| candidate.is_file())
        .ok_or("GNU screen is not installed on this host")?;
    let banner = screen_banner(&screen)?;
    let version = screen_surface(&banner)
        .ok_or_else(|| format!("{} did not report a version: {banner:?}", screen.display()))?;
    if version < MINIMUM_SCREEN_SURFACE {
        let (major, minor) = MINIMUM_SCREEN_SURFACE;
        return Err(format!(
            "{banner} predates the screen {major}.{minor} surface these rows measure"
        ));
    }
    Ok(screen)
}

/// GNU screen prints its banner and then exits non-zero, so only the text is
/// meaningful here, and builds differ over which stream carries it.
#[cfg(unix)]
fn screen_banner(screen: &Path) -> Result<String, String> {
    let output = std::process::Command::new(screen)
        .arg("-v")
        .output()
        .map_err(|error| format!("failed to run {}: {error}", screen.display()))?;
    let streams = [output.stdout, output.stderr];
    let banner = streams.iter().find_map(|stream| {
        String::from_utf8_lossy(stream)
            .lines()
            .find(|line| !line.trim().is_empty())
            .map(|line| line.trim().to_owned())
    });
    banner.ok_or_else(|| format!("{} printed no version banner", screen.display()))
}

/// `Screen version 4.09.01 (GNU) 20-Aug-23` is `(4, 9)`.
#[cfg(unix)]
fn screen_surface(banner: &str) -> Option<(u32, u32)> {
    let mut fields = banner.strip_prefix("Screen version ")?.split_whitespace();
    let mut numbers = fields.next()?.split('.');
    let major = numbers.next()?.parse().ok()?;
    let minor = numbers.next()?.parse().ok()?;
    Some((major, minor))
}

/// The gate has to separate the two generations hosts actually ship, or the
/// native cases either lose a host that can run them or fail on one that
/// cannot.
#[cfg(unix)]
#[test]
fn the_native_screen_gate_separates_the_generations_hosts_ship() {
    let targeted = screen_surface(SCREEN_BANNER).expect("the banner the adapter targets");
    let apple =
        screen_surface("Screen version 4.00.03 (FAU) 23-Oct-06").expect("the banner Apple ships");
    assert_eq!(targeted, (4, 9));
    assert_eq!(apple, (4, 0));
    assert!(
        targeted >= MINIMUM_SCREEN_SURFACE,
        "the surface the adapter targets must still run these rows"
    );
    assert!(
        apple < MINIMUM_SCREEN_SURFACE,
        "a screen without -Q must not be asked to measure them"
    );
    assert_eq!(screen_surface("There is a screen on:"), None);
}

fn payload(platform: &str, tools: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "schema": 1,
        "kind": "rmux-public-benchmark",
        "complete": true,
        "generated_at": "2026-01-01T00:00:00Z",
        "platform": {"id": platform, "name": platform},
        "git": {"branch": "spec", "commit": "0".repeat(40)},
        "tools": tools,
        "baseline": "tmux",
        "units": "ms",
        "lower_is_better": true,
        "notes": [],
        "operations": [],
    })
}

/// Render one payload and return the generated Markdown.
fn render_payload(label: &str, payload: &serde_json::Value) -> String {
    let workspace = temp_dir(label);
    let input = workspace.join("payload.json");
    fs::write(
        &input,
        serde_json::to_vec_pretty(payload).expect("encode payload"),
    )
    .expect("write payload");
    let output_path = workspace.join("benchmarks.md");
    let output = python3::command()
        .arg("scripts/bench/render.py")
        .arg(&input)
        .arg("--output")
        .arg(&output_path)
        .arg("--asset-dir")
        .arg(workspace.join("assets"))
        .current_dir(repo_root())
        .output()
        .expect("failed to run render.py");
    assert!(
        output.status.success(),
        "{}",
        describe("render.py", &output)
    );
    let markdown = fs::read_to_string(&output_path).expect("read rendered markdown");
    fs::remove_dir_all(&workspace).expect("remove render workspace");
    markdown
}

#[test]
fn screen_commands_match_the_gnu_screen_surface() {
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
print(json.dumps({{
    'default': bench.screen_create_command('screen', 'bench'),
    'scrollback': bench.screen_create_command(
        'screen', 'bench', program=['/bin/sh', '-c', 'payload'], scrollback=10000
    ),
    'control': bench.screen_control_command('screen', 'bench', ['-X', 'hardcopy', '-h', '/tmp/f']),
    'operations': sorted(bench.screen_operations('screen', 3)),
    'tools': bench.TOOLS,
}}))
"
    ));

    // No program argument: screen starts the login shell, which is the payload
    // the tmux-like adapters measure for the same rows.
    assert_eq!(
        observed["default"],
        serde_json::json!(["screen", "-dmS", "bench"]),
        "a default screen session must not pin an explicit shell"
    );
    // Options precede the program, or screen passes `-h 10000` to the shell,
    // and the program arrives as an argv vector rather than a command line.
    assert_eq!(
        observed["scrollback"],
        serde_json::json!(["screen", "-dmS", "bench", "-h", "10000", "/bin/sh", "-c", "payload"]),
        "scrollback depth must be an option, ahead of the measured payload"
    );
    assert_eq!(
        observed["control"],
        serde_json::json!(["screen", "-S", "bench", "-X", "hardcopy", "-h", "/tmp/f"]),
        "control commands must address the session by name"
    );
    assert_eq!(
        observed["operations"],
        serde_json::json!(SCREEN_OPERATIONS),
        "the screen adapter must expose exactly its strict equivalents"
    );
    assert_eq!(
        observed["tools"],
        serde_json::json!(["rmux", "tmux", "zellij", "screen"]),
        "screen must be selectable through --only-tools"
    );
}

/// tmux and zellij hand their trailing session argument to a shell; screen
/// execs its program argument directly. Passing the tmux-shaped command line to
/// screen named one non-existent executable, so the session died on startup and
/// the scrollback row was omitted from every artifact.
#[test]
fn the_measured_payload_reaches_screen_as_an_argv_vector() {
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
print(json.dumps({{
    'shell': bench.SHELL,
    'argv': bench.output_argv(10000),
    'script': bench.output_script(10000),
    'command': bench.output_command(10000),
    'sentinel': bench.output_sentinel(10000),
    'create_tail': bench.screen_create_command(
        'screen', 'bench', program=bench.output_argv(10000), scrollback=10000
    )[3:],
}}))
"
    ));
    let shell = observed["shell"].as_str().expect("shell");
    let script = observed["script"].as_str().expect("script");
    let command = observed["command"].as_str().expect("command");

    assert_eq!(
        observed["argv"],
        serde_json::json!([shell, "-c", script]),
        "screen execs its program argument, so the payload must be split the way execvp takes it"
    );
    assert_eq!(
        observed["create_tail"],
        serde_json::json!(["-h", "10000", shell, "-c", script]),
        "the created session must carry the payload as separate argv elements"
    );

    // The exact workload this row is named for.
    assert!(
        script.contains("-lt 10000"),
        "the scrollback row must keep printing 10,000 lines: {script}"
    );
    assert_eq!(
        observed["sentinel"], "rmux-bench-09999",
        "the readiness sentinel must be the last line the 10,000-line payload prints"
    );
    assert!(
        command.contains(script),
        "screen and the tmux-like rows must measure one workload, not two: {command}"
    );

    // Vacuous unless the shell-command form really is a single quoted command
    // line, which is what screen would have looked up as one program name.
    assert_ne!(
        command, script,
        "the spec is vacuous unless the two payload forms really differ"
    );
    assert!(
        command.starts_with(&format!("{shell} -c ")) && command.contains('\''),
        "the spec is vacuous unless the tmux form really is a quoted command line: {command}"
    );
}

/// GNU screen keeps only the first 79 characters of a session name. The
/// scrollback operation is the one whose shared socket name overflows that, and
/// a truncated name makes the capture and the cleanup that follow it address a
/// session that does not exist.
///
/// Both sides of the limit, and the uniqueness that has to survive shortening,
/// are built from fixed pids and timestamps. A live name carries this host's
/// pid and this host's clock: the width of the pid decides which side of the
/// limit the name lands on, and a clock coarser than a sample hands two calls
/// the same timestamp. Measuring those proves a different thing on every host.
#[test]
fn screen_session_names_fit_the_length_screen_keeps() {
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
scrollback = 'capture_pane_200x50_scrollback_10k'

def named(pid, nanos):
    real = (bench.os.getpid, bench.time.time_ns)
    bench.os.getpid, bench.time.time_ns = (lambda: pid), (lambda: nanos)
    try:
        return {{
            'unique': f'-{{pid}}-{{nanos}}',
            'raw': bench.socket_name(scrollback, 'screen'),
            'name': bench.screen_session_name(scrollback),
        }}
    finally:
        bench.os.getpid, bench.time.time_ns = real

print(json.dumps({{
    'limit': bench.SCREEN_NAME_LIMIT,
    'names': {{op: bench.screen_session_name(op) for op in bench.screen_operations('screen', 1)}},
    'over_the_limit': named(1234567, 1780000000000000001),
    'next_over_the_limit': named(1234567, 1780000000000000002),
    'at_the_limit': named(999999, 1780000000000000001),
}}))
"
    ));
    let limit = observed["limit"].as_u64().expect("limit") as usize;
    assert_eq!(
        limit, 79,
        "GNU screen 4.09.01 keeps 79 characters of a session name"
    );

    let names = observed["names"].as_object().expect("session names");
    assert_eq!(
        names.len(),
        SCREEN_OPERATIONS.len(),
        "every screen operation must name a session"
    );
    for (operation, name) in names {
        let name = name.as_str().expect("session name");
        assert!(
            name.len() <= limit,
            "{operation} builds a {}-character session name; screen truncates it and every later \
             lookup, capture and cleanup then misses the session: {name}",
            name.len()
        );
        assert!(
            name.starts_with("rmux-bench-screen-"),
            "a session name must stay attributable to this benchmark: {name}"
        );
    }

    // A seven-digit pid: the unguarded shared name overflows, and the guard
    // must shorten it to exactly what screen keeps without losing what makes
    // it unique or attributable.
    let over = &observed["over_the_limit"];
    assert_eq!(
        over["unique"], "-1234567-1780000000000000001",
        "the overflowing name must be built from a fixed pid and timestamp"
    );
    let overflowing = over["raw"].as_str().expect("raw name");
    assert!(
        overflowing.len() > limit,
        "the spec is vacuous unless the built socket name really exceeds what screen keeps: \
         {} characters",
        overflowing.len()
    );
    let shortened = over["name"].as_str().expect("shortened name");
    assert_eq!(
        shortened.len(),
        limit,
        "an overflowing name must be shortened to exactly what screen keeps: {shortened}"
    );
    assert!(
        shortened.ends_with(over["unique"].as_str().expect("unique suffix")),
        "shortening must keep the pid and timestamp that make the name unique: {shortened}"
    );
    assert!(
        shortened.starts_with("rmux-bench-screen-"),
        "a shortened name must stay attributable to this benchmark: {shortened}"
    );

    // A six-digit pid: the same builder lands exactly on the limit, which
    // screen keeps whole. Rewriting it would drop characters screen never
    // asked for.
    let fitting = &observed["at_the_limit"];
    assert_eq!(
        fitting["unique"], "-999999-1780000000000000001",
        "the fitting name must be built from a fixed pid and timestamp"
    );
    let kept = fitting["raw"].as_str().expect("raw name");
    assert_eq!(
        kept.len(),
        limit,
        "the spec must also cover the name that lands on the limit: {} characters",
        kept.len()
    );
    assert_eq!(
        fitting["name"].as_str().expect("kept name"),
        kept,
        "a name screen keeps whole must be left as it is: {kept}"
    );

    // Shortening the operation must not cost the name its uniqueness: two
    // samples of one operation differ only in the timestamp, and the timestamp
    // is the part shortening keeps.
    let next = &observed["next_over_the_limit"];
    assert_eq!(
        next["unique"], "-1234567-1780000000000000002",
        "the second overflowing name must differ from the first only in its timestamp"
    );
    assert_ne!(
        next["name"], over["name"],
        "concurrent samples must not collide once shortened: {}",
        next["name"]
    );
}

#[test]
fn every_screen_operation_is_a_known_benchmark_row() {
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
print(json.dumps({{'known': [label for label, _ in bench.OPERATIONS]}}))
"
    ));
    let known: Vec<&str> = observed["known"]
        .as_array()
        .expect("operation list")
        .iter()
        .map(|value| value.as_str().expect("operation id"))
        .collect();
    for operation in SCREEN_OPERATIONS {
        assert!(
            known.contains(&operation),
            "screen measures {operation}, which is not a benchmark row and would never be collected"
        );
    }
}

#[test]
fn screen_listing_tolerates_its_failing_exit_status() {
    let workspace = temp_dir("screen-listing");
    let stub = write_screen_stub(&workspace);
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
stub = {stub:?}
unchecked = bench.timed_unchecked([stub, '-ls'])
try:
    bench.timed([stub, '-ls'])
    checked = 'accepted'
except Exception as error:
    checked = type(error).__name__
print(json.dumps({{'unchecked_ms': unchecked, 'checked': checked}}))
",
        stub = stub.to_string_lossy()
    ));

    assert!(
        observed["unchecked_ms"].as_f64().expect("elapsed ms") >= 0.0,
        "screen -ls must produce a sample despite exiting nonzero"
    );
    assert_eq!(
        observed["checked"], "CalledProcessError",
        "the spec is vacuous unless the checked timer really rejects screen -ls"
    );
    fs::remove_dir_all(&workspace).expect("remove listing workspace");
}

#[test]
fn screen_version_metadata_survives_a_failing_version_probe() {
    let workspace = temp_dir("screen-version");
    write_screen_stub(&workspace);
    let empty = temp_dir("screen-empty-path");
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
os.environ['PATH'] = {dir:?} + os.pathsep + os.environ['PATH']
tolerant = bench.version('screen', '-v', accept_nonzero_exit=True)
strict = bench.version('screen', '-v')
os.environ['PATH'] = {empty:?}
absent = bench.version('screen', '-v', accept_nonzero_exit=True)
print(json.dumps({{'tolerant': tolerant, 'strict': strict, 'absent': absent}}))
",
        dir = workspace.to_string_lossy(),
        empty = empty.to_string_lossy()
    ));
    fs::remove_dir_all(&empty).expect("remove empty path directory");

    assert_eq!(
        observed["tolerant"], SCREEN_BANNER,
        "an installed screen must publish its real version, not the literal \"available\""
    );
    assert_eq!(
        observed["strict"], "available",
        "the spec is vacuous unless the default probe really discards a failing exit status"
    );
    assert!(
        observed["absent"].is_null(),
        "an absent screen must report no version at all, not \"available\""
    );
    fs::remove_dir_all(&workspace).expect("remove version workspace");
}

#[test]
fn an_absent_screen_is_omitted_rather_than_estimated() {
    let workspace = temp_dir("screen-absent");
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
bench.shutil.which = lambda name, *args, **kwargs: None
try:
    bench.collect(
        __import__('pathlib').Path({out:?}),
        1,
        __import__('pathlib').Path({out:?}),
        rmux_layout='spec',
        rmux_public_binary=None,
        rmux_helper_binary=None,
        rmux_daemon_binary=None,
        progress_enabled=False,
        sample_progress=False,
        only_operations=None,
        selected_tools={{'screen'}},
    )
    outcome = 'measured'
except SystemExit as error:
    outcome = str(error)
print(json.dumps({{'outcome': outcome}}))
",
        out = workspace.join("out.json").to_string_lossy()
    ));

    assert_eq!(
        observed["outcome"], "no selected benchmark tools are available",
        "an absent screen must abort the run instead of emitting an empty or invented column"
    );
    assert!(
        !workspace.join("out.json").exists(),
        "no artifact may be written for a tool that was never measured"
    );
    fs::remove_dir_all(&workspace).expect("remove absent workspace");
}

#[test]
fn screen_measurements_reach_the_rendered_table() {
    let workspace = temp_dir("screen-pipeline");
    let stub = write_screen_stub(&workspace);
    let artifact = workspace.join("screen.json");
    let path = format!(
        "{}{}{}",
        workspace.display(),
        if cfg!(windows) { ";" } else { ":" },
        std::env::var("PATH").unwrap_or_default()
    );

    let output = python3::command()
        .arg("scripts/bench/bench_unix.py")
        .arg("--out")
        .arg(&artifact)
        .args(["--iterations", "1"])
        .arg("--binary")
        .arg(&stub)
        .args(["--only-tools", "screen"])
        .args(["--only-operations", "list_sessions_default,kill_session"])
        .arg("--quiet")
        .env("PATH", &path)
        .current_dir(repo_root())
        .output()
        .expect("failed to run bench_unix.py");
    assert!(
        output.status.success(),
        "{}",
        describe("bench_unix.py", &output)
    );

    let collected: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&artifact).expect("read artifact"))
            .expect("parse artifact");
    assert_eq!(collected["tools"], serde_json::json!(["screen"]));
    assert_eq!(collected["complete"], serde_json::json!(true));
    assert_eq!(
        collected["notes"],
        serde_json::json!([]),
        "a healthy screen run must record no omission note: {}",
        collected["notes"]
    );
    assert_eq!(
        collected["tool_versions"]["screen"], SCREEN_BANNER,
        "the collected artifact must carry screen's own version metadata"
    );
    assert_eq!(
        collected["tool_environments"]["screen"], "native",
        "a Unix collector reaches screen natively and must say so"
    );
    for operation in ["list_sessions_default", "kill_session"] {
        let row = collected["operations"]
            .as_array()
            .expect("operations")
            .iter()
            .find(|row| row["id"] == operation)
            .unwrap_or_else(|| panic!("{operation} row is missing from the artifact"));
        assert!(
            row["metrics"]["screen"]["p50_ms"].is_number(),
            "{operation} must carry a screen p50: {row}"
        );
        assert!(
            row["metrics"]["screen"]["samples_ms"]
                .as_array()
                .is_some_and(|samples| samples.len() == 1),
            "{operation} must retain its raw samples: {row}"
        );
    }

    let markdown = render_payload("screen-pipeline-render", &collected);
    assert!(
        markdown.contains("<th align=\"right\">screen</th>"),
        "the rendered table must publish the screen column:\n{markdown}"
    );
    assert!(
        markdown.contains("List sessions"),
        "the rendered table must publish the measured screen rows:\n{markdown}"
    );
    fs::remove_dir_all(&workspace).expect("remove pipeline workspace");
}

/// The blocking behaviour, measured against the real binary: the session must
/// survive its program argument and its whole 10,000-line buffer must reach the
/// capture. A stub cannot prove this, because a stub never execs the payload.
#[cfg(unix)]
#[test]
fn a_real_screen_captures_the_whole_ten_thousand_line_scrollback() {
    let screen = match real_screen() {
        Ok(screen) => screen,
        Err(reason) => {
            eprintln!(
                "skipped a_real_screen_captures_the_whole_ten_thousand_line_scrollback: {reason}"
            );
            return;
        }
    };
    // Read what the adapter's own timed command captured, before the adapter
    // removes it. Anything else would prove a session this spec built rather
    // than the operation the benchmark publishes.
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
import time
from pathlib import Path
screen = {screen:?}
sentinel = bench.output_sentinel(10000)
seen = {{}}
timed = bench.timed


def spy(cmd, **kwargs):
    elapsed = timed(cmd, **kwargs)
    target = Path(cmd[-1])
    deadline = time.monotonic() + 3.0
    while True:
        seen['body'] = target.read_text(errors='replace')
        if sentinel in seen['body'] or time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    seen['cmd'] = cmd
    return elapsed


bench.timed = spy
try:
    sample = bench.screen_capture_scrollback(screen)
finally:
    bench.timed = timed
body = seen['body']
print(json.dumps({{
    'name_length': len(bench.screen_session_name('capture_pane_200x50_scrollback_10k')),
    'timed_command': seen['cmd'][3:6],
    'captured_lines': body.count('rmux-bench-'),
    'has_first': 'rmux-bench-00000' in body,
    'has_last': sentinel in body,
    'sample_ms': sample,
}}))
",
        screen = screen.to_string_lossy()
    ));

    assert_eq!(
        observed["timed_command"],
        serde_json::json!(["-X", "hardcopy", "-h"]),
        "the timed command must be the scrollback capture itself"
    );

    assert!(
        observed["name_length"].as_u64().expect("name length") <= 79,
        "the session the capture addresses must be one screen can still find"
    );
    assert_eq!(
        observed["captured_lines"], 10000,
        "the scrollback row must capture its whole 10,000-line workload, not an empty \
         or partial buffer"
    );
    assert_eq!(
        observed["has_first"],
        serde_json::json!(true),
        "the capture must reach back to the first line the payload printed"
    );
    assert_eq!(
        observed["has_last"],
        serde_json::json!(true),
        "the capture must include the last line the payload printed"
    );
    assert!(
        observed["sample_ms"].as_f64().expect("sample") > 0.0,
        "the adapter operation itself must produce a measurement"
    );
}

/// Eight of eight: every operation GNU screen can express must reach the
/// artifact as a comparable measurement, with no omission note.
#[cfg(unix)]
#[test]
fn a_real_screen_measures_all_eight_comparable_operations() {
    if let Err(reason) = real_screen() {
        eprintln!("skipped a_real_screen_measures_all_eight_comparable_operations: {reason}");
        return;
    }
    let workspace = temp_dir("screen-native-accounting");
    let artifact = workspace.join("screen.json");
    let output = python3::command()
        .arg("scripts/bench/bench_unix.py")
        .arg("--out")
        .arg(&artifact)
        .args(["--iterations", "1"])
        .arg("--binary")
        .arg(repo_root().join("scripts/bench/bench_unix.py"))
        .args(["--only-tools", "screen"])
        .args(["--only-operations", &SCREEN_OPERATIONS.join(",")])
        .arg("--quiet")
        .current_dir(repo_root())
        .output()
        .expect("failed to run bench_unix.py");
    assert!(
        output.status.success(),
        "{}",
        describe("bench_unix.py", &output)
    );

    let collected: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&artifact).expect("read artifact"))
            .expect("parse artifact");
    assert_eq!(
        collected["notes"],
        serde_json::json!([]),
        "a real screen run must omit nothing: {}",
        collected["notes"]
    );
    let mut measured: Vec<&str> = collected["operations"]
        .as_array()
        .expect("operations")
        .iter()
        .filter(|row| row["metrics"]["screen"]["p50_ms"].is_number())
        .map(|row| row["id"].as_str().expect("operation id"))
        .collect();
    measured.sort_unstable();
    assert_eq!(
        measured, SCREEN_OPERATIONS,
        "all eight screen-comparable operations must carry a measurement"
    );
    fs::remove_dir_all(&workspace).expect("remove native accounting workspace");
}

/// Every spelling this host's temporary root can reach a note in: written
/// plainly, and written through the `repr` that quotes the command inside a
/// `CalledProcessError`, which doubles each backslash. On a root whose
/// separator never needs escaping the two spellings are the same text, so a
/// case that checks both is exact everywhere and platform-specific nowhere.
fn path_renderings(root: &str) -> [String; 2] {
    let root = root.trim_end_matches(['/', '\\']).to_owned();
    let escaped = root.replace('\\', r"\\");
    [root, escaped]
}

/// A published artifact records which tool failed on which operation. It must
/// not also record where this host keeps its temporary files.
#[test]
fn an_omission_note_does_not_publish_a_host_temporary_path() {
    let workspace = temp_dir("screen-note-redaction");
    let stub = write_capture_failing_stub(&workspace);
    let artifact = workspace.join("screen.json");
    let path = format!(
        "{}{}{}",
        workspace.display(),
        if cfg!(windows) { ";" } else { ":" },
        std::env::var("PATH").unwrap_or_default()
    );

    let output = python3::command()
        .arg("scripts/bench/bench_unix.py")
        .arg("--out")
        .arg(&artifact)
        .args(["--iterations", "1"])
        .arg("--binary")
        .arg(&stub)
        .args(["--only-tools", "screen"])
        .args(["--only-operations", "capture_pane_80x24"])
        .arg("--quiet")
        .env("PATH", &path)
        .env("TMPDIR", &workspace)
        .env("TEMP", &workspace)
        .env("TMP", &workspace)
        .current_dir(repo_root())
        .output()
        .expect("failed to run bench_unix.py");
    assert!(
        output.status.success(),
        "{}",
        describe("bench_unix.py", &output)
    );

    let collected: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&artifact).expect("read artifact"))
            .expect("parse artifact");
    let notes = collected["notes"].as_array().expect("notes");
    assert_eq!(
        notes.len(),
        1,
        "the spec is vacuous unless the capture really failed and was recorded: {notes:?}"
    );
    let note = notes[0].as_str().expect("note text");

    // Provenance the reader needs.
    assert!(
        note.starts_with("screen/capture_pane_80x24:"),
        "the note must still say which tool failed on which operation: {note}"
    );
    assert!(
        note.contains("hardcopy"),
        "the note must still say which command failed: {note}"
    );
    // The placeholder proves a temporary path really was present and replaced.
    assert!(
        note.contains("<temp>"),
        "the spec is vacuous unless the failing command really quoted a temporary path: {note}"
    );

    for rendering in path_renderings(&workspace.to_string_lossy()) {
        assert!(
            !note.contains(&rendering),
            "the note must not disclose this host's temporary location as {rendering}: {note}"
        );
    }
    fs::remove_dir_all(&workspace).expect("remove note redaction workspace");
}

/// The exact note the collector recorded when the scrollback session died: it
/// carried the whole failing command, including the private capture file.
#[test]
fn the_recorded_scrollback_failure_keeps_its_provenance_without_its_path() {
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
import tempfile, os
leaked = (
    'screen/capture_pane_200x50_scrollback_10k: CalledProcessError: Command '
    + repr(['screen', '-S', 'rmux-bench-screen', '-X', 'hardcopy', '-h',
            os.path.join(tempfile.gettempdir(), 'tmpil47a80n')])
    + \" returned non-zero exit status 1.\"
)
print(json.dumps({{
    'leaked': leaked,
    'clean': bench.sanitize(leaked),
    'raw_root': tempfile.gettempdir(),
    'root': bench.sanitize(tempfile.gettempdir()),
    'unrelated': bench.sanitize('screen/list_sessions_default: TimeoutExpired'),
}}))
"
    ));
    let leaked = observed["leaked"].as_str().expect("leaked note");
    let clean = observed["clean"].as_str().expect("clean note");
    let raw_root = observed["raw_root"]
        .as_str()
        .expect("Python temporary root");
    let renderings = path_renderings(raw_root);

    // Vacuous unless the historical note really carried the path, in whichever
    // spelling `repr` gave it on this host.
    assert!(
        renderings
            .iter()
            .any(|rendering| leaked.contains(rendering)),
        "the spec is vacuous unless the recorded note really quoted a temporary path: {leaked}"
    );
    for rendering in &renderings {
        assert!(
            !clean.contains(rendering),
            "the published note must not disclose this host's temporary location \
             as {rendering}: {clean}"
        );
    }
    assert!(
        clean.starts_with("screen/capture_pane_200x50_scrollback_10k: CalledProcessError:")
            && clean.contains("hardcopy")
            && clean.contains("non-zero exit status 1"),
        "redaction must keep the tool, the operation, the command and the failure: {clean}"
    );
    assert_eq!(
        observed["root"], "<temp>",
        "the temporary root alone is host identity too, not just paths under it"
    );
    assert_eq!(
        observed["unrelated"], "screen/list_sessions_default: TimeoutExpired",
        "a note with no path must survive redaction unchanged"
    );
}

/// Redaction is bounded by path components. The temporary root and what is
/// under it are this host's location; a neighbour that merely shares the root's
/// spelling is a different path, and reducing it deletes provenance the reader
/// needs while announcing a redaction that never happened.
#[test]
fn redaction_stops_at_the_temporary_root_and_its_descendants() {
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
import tempfile, os
root = tempfile.gettempdir()
child = os.path.join(root, 'rmux-bench-screen-x', 'capture.txt')
print(json.dumps({{
    'clean_child': bench.sanitize(child),
    'quoted_child': bench.sanitize(\"hardcopy -h '\" + child + \"'\"),
    'starts_with_root': root + '-not-a-child',
    'clean_starts_with_root': bench.sanitize(root + '-not-a-child'),
    'ends_with_root': 'unrelated' + root,
    'clean_ends_with_root': bench.sanitize('unrelated' + root),
}}))
"
    ));

    // Still reduced: what is under the root, including the quoted capture file
    // a failing command records.
    assert_eq!(
        observed["clean_child"], "<temp>",
        "a path under the temporary root is the host location and must be reduced"
    );
    assert_eq!(
        observed["quoted_child"], "hardcopy -h '<temp>'",
        "the capture file the failing command quotes must be reduced too"
    );

    // Left alone: neighbours that are neither the root nor under it.
    assert_eq!(
        observed["clean_starts_with_root"], observed["starts_with_root"],
        "a path that only starts with the temporary root is not under it: {}",
        observed["clean_starts_with_root"]
    );
    assert_eq!(
        observed["clean_ends_with_root"], observed["ends_with_root"],
        "a path that only ends with the temporary root is not the root: {}",
        observed["clean_ends_with_root"]
    );
}

/// Redaction is defined on the temporary root, not on one spelling of it. A
/// failure note quotes its command through `repr`, which doubles every
/// backslash, so a root spelled with them arrives here as `C:\\Users\\...` and
/// a redaction that only knew the plain spelling would publish the host
/// location it exists to remove. The root is pinned so this case is exact on a
/// host whose own separator is never escaped.
#[test]
fn redaction_reduces_a_temporary_root_whose_separators_are_escaped() {
    let observed = driver_json(&format!(
        "\
import tempfile
pinned = r'C:\\Users\\bench\\AppData\\Local\\Temp'
tempfile.tempdir = pinned
{LOAD_BENCH}
tempfile.tempdir = None
capture = pinned + r'\\tmpil47a80n'
note = (
    'screen/capture_pane_80x24: CalledProcessError: Command '
    + repr(['screen', '-S', 'rmux-bench-screen', '-X', 'hardcopy', capture])
    + ' returned non-zero exit status 1.'
)
neighbour = repr(pinned + '-not-a-child')
print(json.dumps({{
    'escaped_capture': repr(capture)[1:-1],
    'note': note,
    'clean_escaped': bench.sanitize(note),
    'clean_plain': bench.sanitize('hardcopy ' + capture),
    'clean_root': bench.sanitize(repr(pinned)),
    'neighbour': neighbour,
    'clean_neighbour': bench.sanitize(neighbour),
}}))
"
    ));

    // Vacuous unless the quoted command really doubled the separators.
    let note = observed["note"].as_str().expect("note text");
    let escaped_capture = observed["escaped_capture"]
        .as_str()
        .expect("escaped capture path");
    assert!(
        note.contains(escaped_capture),
        "the spec is vacuous unless the quoted command really escaped its separators: {note}"
    );

    assert_eq!(
        observed["clean_escaped"],
        "screen/capture_pane_80x24: CalledProcessError: Command \
         ['screen', '-S', 'rmux-bench-screen', '-X', 'hardcopy', '<temp>'] \
         returned non-zero exit status 1.",
        "an escaped capture path is the same host location and must be reduced, \
         keeping the tool, the operation, the command and the failure"
    );
    assert_eq!(
        observed["clean_plain"], "hardcopy <temp>",
        "the plain spelling of the same root must keep being reduced"
    );
    assert_eq!(
        observed["clean_root"], "'<temp>'",
        "an escaped temporary root alone is host identity too, not just paths under it"
    );
    assert_eq!(
        observed["clean_neighbour"], observed["neighbour"],
        "an escaped neighbour of the root is still not under it: {}",
        observed["clean_neighbour"]
    );
}

#[test]
fn screen_is_ordered_last_and_labelled_by_its_environment() {
    let mut linux = payload("linux", &["screen", "zellij", "tmux", "rmux"]);
    linux["tool_environments"] = serde_json::json!({"screen": "native"});
    let rendered = render_payload("screen-order-linux", &linux);
    let header = rendered
        .lines()
        .find(|line| line.contains("<th align=\"left\">Scenario</th>"))
        .expect("rendered header row");
    assert_eq!(
        header,
        "<tr><th align=\"left\">Scenario</th><th align=\"right\">rmux</th>\
         <th align=\"right\">tmux</th><th align=\"right\">zellij</th>\
         <th align=\"right\">screen</th><th align=\"right\">vs tmux</th></tr>",
        "screen must render after zellij and carry no compatibility suffix on Linux"
    );

    let mut windows = payload("windows", &["rmux", "tmux", "screen"]);
    windows["tool_environments"] =
        serde_json::json!({"rmux": "native", "tmux": "wsl", "screen": "wsl"});
    let rendered = render_payload("screen-order-windows", &windows);
    let header = rendered
        .lines()
        .find(|line| line.contains("<th align=\"left\">Scenario</th>"))
        .expect("rendered header row");
    assert_eq!(
        header,
        "<tr><th align=\"left\">Scenario</th><th align=\"right\">rmux</th>\
         <th align=\"right\">tmux (WSL)</th><th align=\"right\">screen (WSL)</th>\
         <th align=\"right\">vs tmux (WSL)</th></tr>",
        "a WSL tool must never be presented as a native Windows one"
    );

    // Artifacts written before `tool_environments` existed must still be honest.
    let legacy = payload("windows", &["rmux", "tmux", "screen"]);
    let rendered = render_payload("screen-order-legacy", &legacy);
    assert!(
        rendered.contains("<th align=\"right\">tmux (WSL)</th>")
            && rendered.contains("<th align=\"right\">screen (WSL)</th>"),
        "a payload without recorded environments must keep the Windows WSL labels:\n{rendered}"
    );
}

#[test]
fn absent_screen_measurements_render_as_not_comparable() {
    let mut linux = payload("linux", &["rmux", "tmux", "screen"]);
    linux["operations"] = serde_json::json!([{
        "id": "list_sessions_default",
        "label": "list_sessions_default",
        "metrics": {
            "rmux": {"p50_ms": 4.0, "p95_ms": 4.0, "samples_ms": [4.0]},
            "tmux": {"p50_ms": 4.0, "p95_ms": 4.0, "samples_ms": [4.0]},
        },
    }]);
    let rendered = render_payload("screen-missing-cell", &linux);
    let row = rendered
        .lines()
        .find(|line| line.contains("List sessions"))
        .expect("rendered operation row");
    assert!(
        row.contains("<code>-</code>"),
        "an operation screen cannot express must render as not comparable: {row}"
    );
}

/// The comparator band is measured, not chosen. The residual pipeline used
/// `0.95..=1.05`; across the committed `docs/benchmarks/*.csv` tables 71 of 91
/// cells vary by more than 5% between their own fastest and slowest sample, and
/// the one cell the tighter band would flip — Linux `list_windows_20` at ratio
/// 1.0804 — has rmux samples spanning 161% of their median. These cases pin the
/// published band and prove the rejected one is not in force.
#[test]
fn the_same_speed_band_is_the_measured_one() {
    let observed = driver_json(&format!(
        "{LOAD_RENDER}
def verdict(ratio):
    op = {{'metrics': {{
        'rmux': {{'p50_ms': 100.0, 'p95_ms': 100.0}},
        'tmux': {{'p50_ms': 100.0 * ratio, 'p95_ms': 100.0 * ratio}},
    }}}}
    return render.ratio_text(op, 'tmux')

print(json.dumps({{
    'low_edge': verdict(0.80),
    'below_low': verdict(0.79),
    'high_edge': verdict(1.25),
    'above_high': verdict(1.26),
    'observed_linux_list_windows': verdict(1.0804),
    'band': [render.SAME_SPEED_RATIO_LOW, render.SAME_SPEED_RATIO_HIGH],
}}))
"
    ));

    assert_eq!(
        observed["low_edge"], "≈ same speed",
        "the band edges are inclusive"
    );
    assert_eq!(observed["below_low"], "1.3x slower");
    assert_eq!(
        observed["high_edge"], "≈ same speed",
        "the band edges are inclusive"
    );
    assert_eq!(observed["above_high"], "1.3x faster");
    assert_eq!(
        observed["observed_linux_list_windows"], "≈ same speed",
        "an 8% median gap inside 161% sample spread must not be published as a win"
    );
    assert_eq!(observed["band"], serde_json::json!([0.80, 1.25]));
}

#[test]
fn the_published_page_states_the_renderers_methodology() {
    let observed = driver_json(&format!(
        "{LOAD_RENDER}
print(json.dumps({{'methodology': render.methodology('GENERATED', 'COMMIT')}}))
"
    ));
    let methodology = observed["methodology"].as_str().expect("methodology text");
    let page = fs::read_to_string(repo_root().join("docs/benchmarks.md")).expect("read page");

    let mut missing = Vec::new();
    for line in methodology.lines() {
        let line = line.trim();
        if line.is_empty() || line.contains("GENERATED") {
            continue;
        }
        if !page.contains(line) {
            missing.push(line.to_owned());
        }
    }
    assert!(
        missing.is_empty(),
        "docs/benchmarks.md no longer states the renderer's own methodology; \
         regenerate the page after changing render.py: {missing:#?}"
    );
}

/// A published artifact must not carry the identity of the machine that
/// produced it: in-repo binaries are recorded repo-relative, and a version
/// banner that leaks a local path is reduced before it is written.
#[test]
fn collected_artifacts_do_not_carry_host_identity() {
    let observed = driver_json(&format!(
        "{LOAD_BENCH}
import tempfile
from pathlib import Path
inside = Path(bench.ROOT) / 'scripts' / 'bench' / 'bench_unix.py'
outside = Path(bench.ROOT).anchor or '/'
temporary = Path(tempfile.gettempdir()) / 'rmux-bench-binary' / 'rmux'
print(json.dumps({{
    'inside': bench.relative_or_string(inside),
    'absent': bench.relative_or_string(None),
    'temporary': bench.relative_or_string(temporary),
    'root': str(bench.ROOT),
    'outside_is_absolute': bench.relative_or_string(Path(outside)) == str(Path(outside).resolve()),
}}))
"
    ));

    assert_eq!(
        observed["inside"],
        "scripts/bench/bench_unix.py".replace('/', std::path::MAIN_SEPARATOR_STR),
        "an in-repo binary must be recorded relative to the checkout, never by absolute path"
    );
    assert!(
        observed["absent"].is_null(),
        "an unused binary slot must stay null rather than invent a path"
    );
    // The other path an artifact records reaches the same redaction as a note.
    assert_eq!(
        observed["temporary"], "<temp>",
        "a binary under the temporary root must be reduced, not recorded by \
         absolute path (checkout root {})",
        observed["root"]
    );
    assert!(
        observed["outside_is_absolute"]
            .as_bool()
            .expect("outside flag"),
        "the spec is vacuous unless out-of-repo paths really are the fallback case"
    );

    let windows_runner =
        fs::read_to_string(repo_root().join("scripts/bench/run-windows.ps1")).expect("read runner");
    assert!(
        windows_runner.contains(r#"$text -match "[A-Za-z]:\\|\\Users\\""#)
            && windows_runner.contains(r#"return "available""#),
        "the Windows runner must keep reducing version strings that contain a local path"
    );
    let probes = windows_runner.matches("Convert-ToPublicText").count();
    assert!(
        probes >= 4,
        "every Windows text that reaches the artifact must pass the redaction helper, found {probes}"
    );
}
