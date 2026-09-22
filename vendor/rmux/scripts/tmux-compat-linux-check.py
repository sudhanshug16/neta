#!/usr/bin/env python3
"""Run a tmux/RMUX compatibility check on a local Unix host.

The default smoke scope is intentionally release-check friendly: it checks
behaviours that should be identical after normalizing socket paths and branding.
The extended scope adds broad discovery probes and may report actionable gaps on
systems whose tmux version differs from RMUX's tracked compatibility surface.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

ANSI_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\a]*(?:\a|\x1b\\))")
KEY_BINDING_RE = re.compile(
    r"^bind-key\s+(?:-r\s+)?-T\s+(?P<table>\S+)\s+(?P<key>\S+)(?:\s+(?P<command>.*))?$"
)


@dataclass
class CommandResult:
    status: int | None
    stdout: str
    stderr: str
    timed_out: bool = False


@dataclass
class Finding:
    scope: str
    name: str
    summary: str
    tmux: CommandResult | None = None
    rmux: CommandResult | None = None
    diff: str = ""
    notes: list[str] | None = None


class Runner:
    def __init__(self, program: str, socket: Path, tmp: Path, home: Path) -> None:
        self.program = program
        self.socket = socket
        self.tmp = tmp
        self.home = home
        self.home.mkdir(parents=True, exist_ok=True)
        (self.home / ".config").mkdir(parents=True, exist_ok=True)

    def argv(self, args: list[str]) -> list[str]:
        return [self.program, "-S", str(self.socket), "-f", "/dev/null", *args]

    def env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.update(
            {
                "HOME": str(self.home),
                "LC_ALL": "C.UTF-8",
                "RMUX_TMPDIR": str(self.tmp),
                "TERM": "xterm-256color",
                "TMPDIR": str(self.tmp),
                "TMUX_TMPDIR": str(self.tmp),
                "XDG_CONFIG_HOME": str(self.home / ".config"),
            }
        )
        env.pop("TMUX", None)
        return env

    def run(self, args: list[str], *, timeout: float = 5.0, stdin: str | None = None) -> CommandResult:
        try:
            completed = subprocess.run(
                self.argv(args),
                input=stdin,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=self.env(),
                timeout=timeout,
                check=False,
            )
            return CommandResult(completed.returncode, completed.stdout, completed.stderr)
        except subprocess.TimeoutExpired as exc:
            return CommandResult(None, exc.stdout or "", exc.stderr or "", True)

    def kill_server(self) -> None:
        self.run(["kill-server"], timeout=2)


class Check:
    def __init__(self, root: Path, tmux: str, rmux: str) -> None:
        self.root = root
        self.tmp = root / "tmp"
        self.tmp.mkdir(parents=True, exist_ok=True)
        self.tmux = Runner(tmux, root / "tmux.sock", self.tmp, root / "home-tmux")
        self.rmux = Runner(rmux, root / "rmux.sock", self.tmp, root / "home-rmux")
        self.passed: list[str] = []
        self.findings: list[Finding] = []

    def cleanup(self) -> None:
        self.tmux.kill_server()
        self.rmux.kill_server()
        wait_for_missing(self.tmux.socket)
        wait_for_missing(self.rmux.socket)
        remove_stale_socket(self.tmux.socket)
        remove_stale_socket(self.rmux.socket)

    def normalize(self, text: str, *, brand: bool = True) -> str:
        text = ANSI_RE.sub("", text).replace("\r", "")
        text = text.replace(str(self.root), "<ROOT>")
        text = text.replace("tmux.sock", "<SOCKET>")
        text = text.replace("rmux.sock", "<SOCKET>")
        text = re.sub(r"/tmp/tmux-\d+/[^\s]+", "<SOCKET>", text)
        text = re.sub(r"/tmp/rmux-\d+/[^\s]+", "<SOCKET>", text)
        text = re.sub(r"/dev/(pts/\d+|ttys\d+)", "<PTY>", text)
        text = re.sub(r"\$[0-9]+", "$ID", text)
        text = re.sub(r"@[0-9]+", "@ID", text)
        text = re.sub(r"%[0-9]+", "%ID", text)
        text = re.sub(r"created [^)]+", "created <TIME>", text)
        if brand:
            text = text.replace("tmux", "rmux").replace("TMUX", "RMUX")
        return text.strip()

    def compare_exact(
        self,
        scope: str,
        name: str,
        args: list[str],
        *,
        brand: bool = True,
        timeout: float = 5.0,
    ) -> None:
        tmux = self.tmux.run(args, timeout=timeout)
        rmux = self.rmux.run(args, timeout=timeout)
        left = self.normalize(format_result(tmux), brand=brand)
        right = self.normalize(format_result(rmux), brand=brand)
        if left == right:
            self.passed.append(f"{scope}:{name}")
            return
        diff = "\n".join(difflib.unified_diff(left.splitlines(), right.splitlines(), "tmux", "rmux", lineterm=""))
        self.findings.append(Finding(scope, name, f"`{shell_join(args)}` diverges", tmux, rmux, diff))

    def compare_acceptance(self, scope: str, name: str, args: list[str]) -> None:
        tmux = self.tmux.run(args)
        rmux = self.rmux.run(args)
        if tmux.status == rmux.status == 0 and not tmux.timed_out and not rmux.timed_out:
            self.passed.append(f"{scope}:{name}")
            return
        self.findings.append(
            Finding(scope, name, f"`{shell_join(args)}` acceptance differs", tmux, rmux)
        )

    def compare_key_table_contract(self, table: str) -> None:
        args = ["list-keys", "-T", table]
        tmux = self.tmux.run(args)
        rmux = self.rmux.run(args)
        if tmux.status != 0 or rmux.status != 0 or tmux.timed_out or rmux.timed_out:
            self.findings.append(
                Finding("surface", f"list-keys-{table}", f"`{shell_join(args)}` did not run cleanly", tmux, rmux)
            )
            return

        tmux_bindings = parse_key_bindings(tmux.stdout)
        rmux_bindings = parse_key_bindings(rmux.stdout)
        missing = []
        changed = []
        for key, tmux_command in sorted(tmux_bindings.items()):
            rmux_command = rmux_bindings.get(key)
            if rmux_command is None:
                missing.append(key)
                continue
            if first_command_word(tmux_command) != first_command_word(rmux_command):
                changed.append(
                    f"{key}: tmux `{tmux_command}` vs rmux `{rmux_command}`"
                )

        if not missing and not changed:
            self.passed.append(f"surface:list-keys-{table}")
            return

        self.findings.append(
            Finding(
                "surface",
                f"list-keys-{table}",
                "default key table contract diverges",
                tmux,
                rmux,
                notes=[
                    f"missing keys: {', '.join(missing) if missing else '<none>'}",
                    "changed commands:\n" + "\n".join(changed) if changed else "changed commands: <none>",
                ],
            )
        )

    def run_smoke(self) -> None:
        self.cleanup()
        for name, args in [
            ("list-sessions-absent", ["list-sessions"]),
            ("has-session-absent", ["has-session", "-t", "missing"]),
            ("kill-session-absent", ["kill-session", "-t", "missing"]),
            ("attach-session-empty", ["attach-session", "-t", "missing"]),
        ]:
            self.compare_exact("no-server", name, args)

        self.cleanup()
        self.compare_exact("session", "new-session-detached", ["new-session", "-d", "-s", "alpha"])
        for name, args in [
            ("select-pane-current", ["select-pane"]),
            ("resize-pane-noop", ["resize-pane"]),
            ("select-layout-noop", ["select-layout"]),
            ("show-options-current", ["show-options"]),
            ("show-window-options-current", ["show-window-options"]),
            ("show-environment-current", ["show-environment"]),
            ("show-hooks-current", ["show-hooks"]),
            ("break-pane-current", ["break-pane"]),
        ]:
            self.compare_acceptance("implicit-target", name, args)

        self.cleanup()
        for step, args in [
            ("new-0", ["new-session", "-d"]),
            ("new-1", ["new-session", "-d"]),
            ("new-bob", ["new-session", "-d", "-s", "bob"]),
            ("new-target-group", ["new-session", "-d", "-t", "stacy"]),
            ("list-groups", ["list-sessions", "-F", "#{session_name}:#{session_group}:#{session_windows}"]),
        ]:
            self.compare_exact("session-groups", step, args)

        self.run_attached_smoke()

    def run_extended(self) -> None:
        self.run_smoke()
        self.cleanup()
        for name, args in [
            ("unknown-command", ["not-a-command"]),
            ("split-missing-target", ["split-window", "-t", "missing"]),
            ("display-missing-target", ["display-message", "-p", "-t", "missing", "#{session_name}"]),
            ("resize-invalid-size", ["resize-pane", "-x", "notnum"]),
        ]:
            self.compare_exact("error-surface", name, args)

        self.cleanup()
        self.compare_exact("surface", "list-commands-format", ["list-commands", "-F", "#{command_list_name}"])
        for table in ["prefix", "root", "copy-mode", "copy-mode-vi"]:
            self.compare_key_table_contract(table)

    def run_attached_smoke(self) -> None:
        if shutil.which("python3") is None:
            return
        try:
            import pexpect  # type: ignore
        except Exception:
            self.passed.append("attached:skipped-pexpect-unavailable")
            return

        self.cleanup()
        self.tmux.run(["new-session", "-d", "-s", "attached"])
        self.rmux.run(["new-session", "-d", "-s", "attached"])
        for args in [["split-window", "-h", "-t", "attached:0.0"], ["split-window", "-v", "-t", "attached:0.1"]]:
            self.tmux.run(args)
            self.rmux.run(args)

        for name, keys, expected in [
            ("display-panes", "\x02q", ["0", "1"]),
            ("choose-tree", "\x02w", ["sort: index"]),
            ("no-next-window", "\x02n", ["No next window"]),
        ]:
            tmux = capture_attached(pexpect, self.tmux, keys)
            rmux = capture_attached(pexpect, self.rmux, keys)
            missing_tmux = [token for token in expected if token not in tmux]
            missing_rmux = [token for token in expected if token not in rmux]
            if not missing_tmux and not missing_rmux:
                self.passed.append(f"attached:{name}")
                continue
            self.findings.append(
                Finding(
                    "attached",
                    name,
                    f"attached token mismatch tmux_missing={missing_tmux} rmux_missing={missing_rmux}",
                    notes=[f"tmux tail:\n{tmux[-1200:]}", f"rmux tail:\n{rmux[-1200:]}"],
                )
            )

    def write_report(self) -> Path:
        report = self.root / "CHECK.txt"
        data = self.root / "check.json"
        data.write_text(json.dumps({"passed": self.passed, "findings": [asdict(f) for f in self.findings]}, indent=2))
        lines = [
            "# RMUX tmux compatibility check",
            "",
            f"- root: `{self.root}`",
            f"- passed: {len(self.passed)}",
            f"- findings: {len(self.findings)}",
            "",
        ]
        for index, finding in enumerate(self.findings, 1):
            lines.extend([f"## {index}. {finding.scope}: {finding.name}", "", finding.summary, ""])
            if finding.diff:
                lines.extend(["```diff", finding.diff[:8000], "```", ""])
            if finding.notes:
                for note in finding.notes:
                    lines.extend(["```text", note[:4000], "```", ""])
        report.write_text("\n".join(lines))
        return report


def capture_attached(pexpect_module, runner: Runner, keys: str) -> str:
    child = pexpect_module.spawn(
        runner.program,
        ["-S", str(runner.socket), "-f", "/dev/null", "attach-session", "-t", "attached"],
        env=runner.env(),
        encoding="utf-8",
        timeout=4,
        dimensions=(24, 80),
    )
    transcript = ""
    try:
        time.sleep(0.4)
        transcript += child.read_nonblocking(size=8000, timeout=0.2)
    except Exception:
        pass
    child.send(keys)
    time.sleep(0.8)
    try:
        transcript += child.read_nonblocking(size=16000, timeout=0.4)
    except Exception:
        pass
    child.send("\x02d")
    try:
        child.expect(pexpect_module.EOF, timeout=3)
        transcript += child.before or ""
    except Exception:
        child.close(force=True)
    return ANSI_RE.sub("", transcript).replace("\r", "")


def format_result(result: CommandResult) -> str:
    return (
        f"status={result.status} timeout={result.timed_out}\n"
        f"stdout:\n{result.stdout}\n"
        f"stderr:\n{result.stderr}"
    )


def wait_for_missing(path: Path, *, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while path.exists() and time.monotonic() < deadline:
        time.sleep(0.02)


def remove_stale_socket(path: Path) -> None:
    try:
        if path.exists() or path.is_socket():
            path.unlink()
    except OSError:
        pass


def parse_key_bindings(text: str) -> dict[str, str]:
    bindings: dict[str, str] = {}
    for line in ANSI_RE.sub("", text).replace("\r", "").splitlines():
        match = KEY_BINDING_RE.match(line)
        if match is None:
            continue
        key = normalize_key_label(match.group("key"))
        bindings[key] = match.group("command") or ""
    return bindings


def normalize_key_label(label: str) -> str:
    if len(label) >= 2 and label[0] == label[-1] and label[0] in {"'", '"'}:
        label = label[1:-1]
    if label.startswith("\\") and len(label) > 1:
        label = label[1:]

    parts = label.split("-")
    if len(parts) <= 1:
        return label

    modifier_order = {"C": 0, "S": 1, "M": 2}
    modifiers = parts[:-1]
    if not all(modifier in modifier_order for modifier in modifiers):
        return label
    ordered = sorted(modifiers, key=modifier_order.__getitem__)
    return "-".join([*ordered, parts[-1]])


def first_command_word(command: str) -> str:
    words = command.strip().split(maxsplit=1)
    return words[0] if words else ""


def shell_join(args: list[str]) -> str:
    import shlex

    return " ".join(shlex.quote(arg) for arg in args)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tmux", default="tmux")
    parser.add_argument("--rmux", default="target/debug/rmux" if Path("target/debug/rmux").exists() else "rmux")
    parser.add_argument("--root", type=Path, default=None)
    parser.add_argument("--scope", choices=["smoke", "extended"], default="smoke")
    args = parser.parse_args()

    root = args.root or Path(tempfile.mkdtemp(prefix="rmux_tmux_compat_"))
    root.mkdir(parents=True, exist_ok=True)
    check = Check(root, args.tmux, args.rmux)
    try:
        if args.scope == "smoke":
            check.run_smoke()
        else:
            check.run_extended()
    finally:
        check.cleanup()
        report = check.write_report()

    print(f"root={root}")
    print(f"report={report}")
    print(f"passed={len(check.passed)} findings={len(check.findings)}")
    return 0 if not check.findings else 1


if __name__ == "__main__":
    raise SystemExit(main())
