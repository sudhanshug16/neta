use super::*;

fn forged_pipe_with_suffix(suffix: &str) -> io::Result<PathBuf> {
    let identity = rmux_os::identity::IdentityResolver::current()?;
    let rmux_os::identity::UserIdentity::Sid(sid) = identity else {
        return Err(io::Error::other(
            "Windows identity resolver returned a Unix uid",
        ));
    };
    let sid = pipe_component(OsStr::new(sid.as_ref()));
    let integrity = current_integrity_label()?;
    let valid = pipe_path(
        &sid,
        integrity,
        &"a".repeat(crate::windows_endpoint_components::KEY_HEX_LEN),
        &"b".repeat(crate::windows_endpoint_components::NONCE_HEX_LEN),
    );
    let valid = valid.to_string_lossy();
    let prefix_len = valid
        .len()
        .checked_sub(crate::windows_endpoint_components::MANAGED_SUFFIX_LEN)
        .expect("managed suffix length");

    Ok(PathBuf::from(format!("{}{suffix}", &valid[..prefix_len])))
}

#[test]
fn forged_unicode_explicit_endpoint_is_unmanaged_across_entry_paths() -> io::Result<()> {
    let suffix = format!("{}é{}", "a".repeat(63), "a".repeat(32));
    let pipe_name = forged_pipe_with_suffix(&suffix)?;
    let endpoint = crate::resolve_endpoint(None, Some(&pipe_name))?;

    assert_eq!(endpoint.as_path(), pipe_name);
    assert!(legacy_shutdown_endpoint(&pipe_name)?.is_none());

    let reservation = reserve_managed_endpoint_start(&pipe_name)?;
    assert_eq!(reservation.endpoint().as_path(), pipe_name);
    assert!(reservation._claim.is_none());
    assert!(register_running(pipe_name.as_os_str())?.is_none());

    Ok(())
}
