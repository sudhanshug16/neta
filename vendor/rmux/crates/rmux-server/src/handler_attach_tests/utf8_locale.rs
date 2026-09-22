//! UTF-8 locale selection for attach fixtures that type multi-byte input.
//!
//! A shell started in a single-byte locale discards those bytes in its own line
//! editor, before rmux is ever observed handling them, so such a fixture has to
//! establish a UTF-8 locale for the pane. Locale names are not portable, and an
//! unverified name is worse than none: exporting `LC_ALL=C.UTF-8` on a host that
//! does not install it *replaces* a working inherited locale, taking the pane
//! from `UTF-8` to `US-ASCII`. Every value this module returns is therefore
//! backed by evidence from the host itself.

use std::sync::OnceLock;

/// How a fixture can establish a UTF-8 locale for its pane shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Utf8Locale {
    /// Export this name: the host lists it among its installed locales.
    Export(String),
    /// Export nothing: the inherited environment already selects UTF-8.
    Inherit,
    /// Neither probe found one.
    Unavailable,
}

/// The process environment a fixture should pass to `NewSession`.
///
/// # Panics
///
/// Panics when the host establishes no UTF-8 locale. A fixture that types
/// multi-byte input cannot assert anything meaningful there, and failing on the
/// missing precondition is more useful than failing later on lost bytes.
pub(super) fn fixture_environment() -> Option<Vec<String>> {
    match host_locale() {
        Utf8Locale::Export(name) => Some(vec![format!("LC_ALL={name}")]),
        Utf8Locale::Inherit => None,
        Utf8Locale::Unavailable => panic!(
            "no UTF-8 locale is established on this host: `locale -a` listed none and the \
             inherited LC_ALL/LC_CTYPE/LANG do not select one, so a pane shell would discard \
             multi-byte input before rmux observed it"
        ),
    }
}

/// Resolves the choice once per process from this host.
fn host_locale() -> &'static Utf8Locale {
    static HOST_LOCALE: OnceLock<Utf8Locale> = OnceLock::new();
    HOST_LOCALE.get_or_init(|| {
        let installed = std::process::Command::new("locale")
            .arg("-a")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned());
        choose(
            installed.as_deref(),
            environment_value("LC_ALL").as_deref(),
            environment_value("LC_CTYPE").as_deref(),
            environment_value("LANG").as_deref(),
        )
    })
}

/// Chooses a UTF-8 locale from what the host installs, then from what the
/// account already exports.
///
/// `installed` is the output of `locale -a`, or `None` when that command is
/// absent or failed.
fn choose(
    installed: Option<&str>,
    lc_all: Option<&str>,
    lc_ctype: Option<&str>,
    lang: Option<&str>,
) -> Utf8Locale {
    if let Some(name) = installed.and_then(installed_utf8_locale) {
        return Utf8Locale::Export(name.to_owned());
    }
    if effective_ctype(lc_all, lc_ctype, lang).is_some_and(is_utf8_locale) {
        return Utf8Locale::Inherit;
    }
    Utf8Locale::Unavailable
}

/// Picks a UTF-8 entry out of a `locale -a` listing.
///
/// `C.UTF-8` and `en_US.UTF-8` are preferred because they carry no other
/// regional behaviour; any other UTF-8 entry serves equally well for `LC_CTYPE`.
fn installed_utf8_locale(listing: &str) -> Option<&str> {
    let names = || {
        listing
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
    };
    names()
        .find(|name| name.eq_ignore_ascii_case("C.UTF-8"))
        .or_else(|| names().find(|name| name.eq_ignore_ascii_case("en_US.UTF-8")))
        .or_else(|| names().find(|name| is_utf8_locale(name)))
}

/// Applies POSIX precedence: `LC_ALL` overrides `LC_CTYPE`, which overrides
/// `LANG`.
fn effective_ctype<'a>(
    lc_all: Option<&'a str>,
    lc_ctype: Option<&'a str>,
    lang: Option<&'a str>,
) -> Option<&'a str> {
    lc_all.or(lc_ctype).or(lang)
}

/// Reports whether `name` selects a UTF-8 character map.
fn is_utf8_locale(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.ends_with(".utf-8") || name.ends_with(".utf8") || name == "utf-8"
}

/// Reads one locale variable, treating an empty value as unset the way the
/// POSIX precedence rules do.
fn environment_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{choose, effective_ctype, installed_utf8_locale, Utf8Locale};

    const LISTING: &str = "C\nC.UTF-8\nen_US.ISO8859-1\nen_US.UTF-8\nPOSIX\n";

    #[test]
    fn the_parser_prefers_c_utf8_then_en_us_then_any_utf8_entry() {
        assert_eq!(installed_utf8_locale(LISTING), Some("C.UTF-8"));
        assert_eq!(
            installed_utf8_locale("C\nen_US.ISO8859-1\nen_US.UTF-8\n"),
            Some("en_US.UTF-8")
        );
        assert_eq!(
            installed_utf8_locale("C\n  fr_FR.utf8  \nPOSIX\n"),
            Some("fr_FR.utf8")
        );
    }

    #[test]
    fn the_parser_reports_no_match_for_a_single_byte_only_listing() {
        assert_eq!(installed_utf8_locale("C\nPOSIX\nen_US.ISO8859-1\n"), None);
        assert_eq!(installed_utf8_locale(""), None);
    }

    #[test]
    fn an_installed_utf8_locale_is_exported_by_name() {
        assert_eq!(
            choose(Some(LISTING), None, None, None),
            Utf8Locale::Export("C.UTF-8".to_owned())
        );
    }

    #[test]
    fn a_missing_or_failed_locale_command_keeps_an_inherited_utf8_locale() {
        // `installed` is `None` for both an absent `locale` binary and a
        // command that ran and failed: neither established any name.
        assert_eq!(
            choose(None, None, None, Some("en_US.UTF-8")),
            Utf8Locale::Inherit
        );
        assert_eq!(
            choose(None, None, Some("fr_FR.utf8"), None),
            Utf8Locale::Inherit
        );
    }

    #[test]
    fn a_listing_without_any_utf8_entry_keeps_an_inherited_utf8_locale() {
        assert_eq!(
            choose(Some("C\nPOSIX\n"), None, None, Some("en_US.UTF-8")),
            Utf8Locale::Inherit
        );
    }

    #[test]
    fn nothing_is_forced_when_no_probe_establishes_a_utf8_locale() {
        assert_eq!(choose(None, None, None, None), Utf8Locale::Unavailable);
        assert_eq!(
            choose(Some("C\nPOSIX\n"), None, None, Some("en_US.ISO8859-1")),
            Utf8Locale::Unavailable
        );
    }

    #[test]
    fn lc_all_overrides_lc_ctype_and_lang() {
        assert_eq!(
            effective_ctype(Some("C"), Some("en_US.UTF-8"), Some("en_US.UTF-8")),
            Some("C")
        );
        assert_eq!(
            effective_ctype(None, Some("C"), Some("en_US.UTF-8")),
            Some("C")
        );
        assert_eq!(
            effective_ctype(None, None, Some("en_US.UTF-8")),
            Some("en_US.UTF-8")
        );

        // A single-byte `LC_ALL` over a UTF-8 `LANG` is exactly the shape that
        // must not be read as an inherited UTF-8 locale.
        assert_eq!(
            choose(None, Some("C"), None, Some("en_US.UTF-8")),
            Utf8Locale::Unavailable
        );
    }
}
