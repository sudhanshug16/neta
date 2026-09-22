pub mod clipboard;
pub mod input;

use neta_protocol::Target;
use rmux_sdk::ProcessSpec;
use std::path::Path;

/// Builds the local Pi process contract used by an rmux pane.
pub fn local_pi_process(
    target: &Target,
    executable: &str,
    pi_cli: &str,
    acp_extension: &str,
    session_root: &Path,
    editor_ready_path: &Path,
    descriptor: &Path,
    force_acp: bool,
) -> ProcessSpec {
    let mut argv = vec![
        executable.to_owned(),
        pi_cli.to_owned(),
        "--session-dir".into(),
        session_root.to_string_lossy().into_owned(),
        "--session-id".into(),
        target.session_id.clone(),
        "--tui-mode".into(),
        "fullscreen".into(),
        "--extension".into(),
        acp_extension.into(),
    ];
    if target.provider != "pi" || force_acp {
        argv.extend([
            "--provider".into(),
            "neta-acp".into(),
            "--model".into(),
            target.model.clone(),
        ]);
    }
    let mut environment = vec![
        format!("NETA_TARGET_SESSION_ID={}", target.session_id),
        format!("NETA_TARGET_PROVIDER={}", target.provider),
        format!("NETA_TARGET_MODEL={}", target.model),
        format!("NETA_WORKSPACE_ROOT={}", target.cwd),
        format!("NETA_DESCRIPTOR={}", descriptor.display()),
        format!("NETA_FORCE_ACP={}", if force_acp { "1" } else { "0" }),
        format!("NETA_PI_EDITOR_READY_PATH={}", editor_ready_path.display()),
        "NETA_PROXY_TOOLS=disabled".into(),
    ];
    for name in [
        "SSH_CONNECTION",
        "SSH_CLIENT",
        "MOSH_CONNECTION",
        "NETA_FAKE_PI_INPUT_LOG",
        "NETA_FAKE_PI_CWD_LOG",
        "NETA_FAKE_PI_START_LOG",
        "NETA_FAKE_PI_SESSION_INPUT_LOG",
        "NETA_FAKE_PI_SIZE_LOG",
        "NETA_PI_GATE_FILE",
        "NETA_PI_GATE_STARTED_FILE",
        "NETA_REAL_PI_CLI",
    ] {
        if let Ok(value) = std::env::var(name) {
            environment.push(format!("{name}={value}"));
        }
    }
    let mut process = ProcessSpec::argv(argv);
    process.environment = Some(environment);
    process
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_pi_contract_is_fullscreen_and_session_stable() {
        let target = Target {
            session_id: "session-7".into(),
            workspace_id: "workspace-7".into(),
            name: "Lead".into(),
            role: "Workspace leader".into(),
            cwd: "/repo".into(),
            provider: "pi".into(),
            model: "model".into(),
        };
        let process = local_pi_process(
            &target,
            "node",
            "pi.js",
            "acp.ts",
            Path::new("/sessions/7"),
            Path::new("/sessions/7/editor-ready"),
            Path::new("/descriptor/node.json"),
            false,
        );
        assert_eq!(
            process.process_command,
            Some(rmux_sdk::ProcessCommandSpec::Argv(vec![
                "node".into(),
                "pi.js".into(),
                "--session-dir".into(),
                "/sessions/7".into(),
                "--session-id".into(),
                "session-7".into(),
                "--tui-mode".into(),
                "fullscreen".into(),
                "--extension".into(),
                "acp.ts".into(),
            ]))
        );
        assert!(process
            .environment
            .expect("environment")
            .contains(&"NETA_TARGET_SESSION_ID=session-7".into()));
    }

    #[test]
    fn remote_pi_forces_acp_and_uses_the_forwarded_descriptor() {
        let target = Target {
            session_id: "remote-session".into(),
            workspace_id: "workspace".into(),
            name: "Lead".into(),
            role: "Workspace leader".into(),
            cwd: "/remote/repo".into(),
            provider: "pi".into(),
            model: "model".into(),
        };
        let process = local_pi_process(
            &target,
            "node",
            "pi.js",
            "acp.ts",
            Path::new("/sessions"),
            Path::new("/sessions/editor-ready"),
            Path::new("/private/node.json"),
            true,
        );
        let rmux_sdk::ProcessCommandSpec::Argv(argv) = process.process_command.unwrap() else {
            panic!("argv process")
        };
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--provider", "neta-acp"]));
        let environment = process.environment.unwrap();
        assert!(environment.contains(&"NETA_DESCRIPTOR=/private/node.json".into()));
        assert!(environment.contains(&"NETA_FORCE_ACP=1".into()));
        assert!(environment.contains(&"NETA_PROXY_TOOLS=disabled".into()));
    }
}
