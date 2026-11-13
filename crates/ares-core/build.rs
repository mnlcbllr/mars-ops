//! Records the source revision so exported reports can name the code that made them.

use std::process::Command;

fn main() {
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let revision = match git(&["rev-parse", "--short=12", "HEAD"]) {
        Some(hash) if !hash.is_empty() => {
            let dirty = git(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
            if dirty {
                format!("{hash}-dirty")
            } else {
                hash
            }
        }
        _ => "unknown".to_string(),
    };
    println!("cargo:rustc-env=ARES_GIT_REVISION={revision}");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/index");
}
