use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_PROJECT_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) struct CompileFailCase {
    name: &'static str,
    source: String,
    error_code: &'static str,
    diagnostic: &'static str,
}

impl CompileFailCase {
    #[allow(dead_code)]
    pub(crate) fn enum_match(name: &'static str, source: impl Into<String>) -> Self {
        Self {
            name,
            source: source.into(),
            error_code: "error[E0004]",
            diagnostic: "is marked as non-exhaustive",
        }
    }

    #[allow(dead_code)]
    pub(crate) fn struct_literal(name: &'static str, source: impl Into<String>) -> Self {
        Self {
            name,
            source: source.into(),
            error_code: "error[E0639]",
            diagnostic: "non-exhaustive struct",
        }
    }
}

pub(crate) fn assert_compile_fail_cases(
    dependency: &str,
    manifest_dir: &Path,
    cases: &[CompileFailCase],
) {
    let project = ConsumerProject::new(dependency, manifest_dir, cases);
    let cargo_executable = std::env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));

    for case in cases {
        let output = Command::new(&cargo_executable)
            .args([
                "check",
                "--offline",
                "--quiet",
                "--color=never",
                "--bin",
                case.name,
            ])
            .current_dir(&project.root)
            .env("CARGO_TARGET_DIR", project.root.join("target"))
            .env("CARGO_NET_OFFLINE", "true")
            .output()
            .unwrap_or_else(|error| {
                panic!(
                    "failed to launch cargo for compile-fail case `{}`: {error}",
                    case.name
                )
            });
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(
            !output.status.success(),
            "consumer case `{}` compiled; its #[non_exhaustive] contract may have disappeared",
            case.name
        );
        assert!(
            stderr.contains(case.error_code) && stderr.contains(case.diagnostic),
            "consumer case `{}` failed for the wrong reason:\n{stderr}",
            case.name
        );
    }
}

struct ConsumerProject {
    root: PathBuf,
}

impl ConsumerProject {
    fn new(dependency: &str, manifest_dir: &Path, cases: &[CompileFailCase]) -> Self {
        let project_id = NEXT_PROJECT_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "{dependency}-public-api-compile-fail-{}-{project_id}",
            std::process::id()
        ));
        let bin_dir = root.join("src").join("bin");
        fs::create_dir_all(&bin_dir).unwrap_or_else(|error| {
            panic!(
                "failed to create compile-fail project at {}: {error}",
                root.display()
            )
        });

        let dependency_path = toml_string(manifest_dir);
        let manifest = format!(
            "[package]\n\
             name = \"{dependency}-public-api-compile-fail\"\n\
             version = \"0.0.0\"\n\
             edition = \"2021\"\n\
             publish = false\n\
             \n\
             [workspace]\n\
             \n\
             [dependencies]\n\
             {dependency} = {{ path = \"{dependency_path}\" }}\n"
        );
        fs::write(root.join("Cargo.toml"), manifest).unwrap_or_else(|error| {
            panic!(
                "failed to write compile-fail manifest at {}: {error}",
                root.display()
            )
        });
        for case in cases {
            fs::write(bin_dir.join(format!("{}.rs", case.name)), &case.source).unwrap_or_else(
                |error| {
                    panic!(
                        "failed to write compile-fail case `{}` at {}: {error}",
                        case.name,
                        root.display()
                    )
                },
            );
        }

        Self { root }
    }
}

impl Drop for ConsumerProject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn toml_string(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}
