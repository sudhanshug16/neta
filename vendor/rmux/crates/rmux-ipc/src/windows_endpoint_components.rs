//! Strict parsing for Windows managed-endpoint key and nonce components.

pub(crate) const KEY_HEX_LEN: usize = 64;
pub(crate) const NONCE_HEX_LEN: usize = 32;
const SEPARATOR_INDEX: usize = KEY_HEX_LEN;
pub(crate) const MANAGED_SUFFIX_LEN: usize = KEY_HEX_LEN + 1 + NONCE_HEX_LEN;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ManagedHexComponents<'a> {
    pub(crate) key: &'a str,
    pub(crate) nonce: &'a str,
}

pub(crate) fn parse_managed_hex_components(value: &str) -> Option<ManagedHexComponents<'_>> {
    if value.len() != MANAGED_SUFFIX_LEN
        || !value.is_ascii()
        || !value.bytes().enumerate().all(valid_suffix_byte)
    {
        return None;
    }

    let (key, nonce) = value.split_once('-')?;
    Some(ManagedHexComponents { key, nonce })
}

pub(crate) fn is_lower_hex(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(is_lower_hex_byte)
}

fn valid_suffix_byte((index, byte): (usize, u8)) -> bool {
    if index == SEPARATOR_INDEX {
        byte == b'-'
    } else {
        is_lower_hex_byte(byte)
    }
}

fn is_lower_hex_byte(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

#[cfg(test)]
mod tests {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use super::*;

    fn valid_suffix() -> String {
        format!(
            "{}-{}",
            "0123456789abcdef".repeat(KEY_HEX_LEN / 16),
            "fedcba9876543210".repeat(NONCE_HEX_LEN / 16)
        )
    }

    #[test]
    fn valid_lower_hex_components_are_preserved() {
        let suffix = valid_suffix();
        let parsed = parse_managed_hex_components(&suffix).expect("valid managed suffix");

        assert!(is_lower_hex(parsed.key));
        assert!(is_lower_hex(parsed.nonce));
        assert_eq!(parsed.key, &suffix[..KEY_HEX_LEN]);
        assert_eq!(parsed.nonce, &suffix[KEY_HEX_LEN + 1..]);
    }

    #[test]
    fn malformed_lengths_are_rejected() {
        for length in 0..=MANAGED_SUFFIX_LEN * 2 {
            let mut value = "a".repeat(length);
            if length > SEPARATOR_INDEX {
                value.replace_range(SEPARATOR_INDEX..=SEPARATOR_INDEX, "-");
            }

            assert_eq!(
                parse_managed_hex_components(&value).is_some(),
                length == MANAGED_SUFFIX_LEN,
                "unexpected result for byte length {length}"
            );
        }
    }

    #[test]
    fn malformed_separator_and_hex_are_rejected() {
        let suffix = valid_suffix();
        let mut cases = Vec::new();

        let mut wrong_separator = suffix.clone().into_bytes();
        wrong_separator[SEPARATOR_INDEX] = b'a';
        cases.push(String::from_utf8(wrong_separator).expect("ASCII suffix"));

        let mut shifted_separator = suffix.clone().into_bytes();
        shifted_separator[SEPARATOR_INDEX - 1] = b'-';
        shifted_separator[SEPARATOR_INDEX] = b'a';
        cases.push(String::from_utf8(shifted_separator).expect("ASCII suffix"));

        for (index, replacement) in [(0, b'A'), (KEY_HEX_LEN - 1, b'g'), (KEY_HEX_LEN + 1, b'/')] {
            let mut malformed = suffix.clone().into_bytes();
            malformed[index] = replacement;
            cases.push(String::from_utf8(malformed).expect("ASCII suffix"));
        }

        for value in cases {
            assert_eq!(parse_managed_hex_components(&value), None);
        }
    }

    #[test]
    fn non_ascii_at_utf8_boundaries_63_64_65_is_rejected_without_panicking() {
        for start in [63, 64, 65] {
            let character = 'é';
            let trailing = MANAGED_SUFFIX_LEN - start - character.len_utf8();
            let value = format!("{}{character}{}", "a".repeat(start), "a".repeat(trailing));

            assert_eq!(value.len(), MANAGED_SUFFIX_LEN);
            let result = catch_unwind(AssertUnwindSafe(|| parse_managed_hex_components(&value)));
            assert!(result.is_ok(), "parser panicked at UTF-8 byte {start}");
            assert_eq!(result.expect("no panic"), None);
        }
    }

    #[test]
    fn arbitrary_unicode_inputs_never_panic() {
        for ascii_len in 0..=MANAGED_SUFFIX_LEN + 2 {
            for insertion in 0..=ascii_len {
                for character in ['é', '€', '中', '🦀', '\u{fffd}'] {
                    let mut value = "a".repeat(ascii_len);
                    value.insert(insertion, character);

                    let result =
                        catch_unwind(AssertUnwindSafe(|| parse_managed_hex_components(&value)));
                    assert!(
                        result.is_ok(),
                        "parser panicked for byte length {} at insertion {insertion}",
                        value.len()
                    );
                    assert_eq!(result.expect("no panic"), None);
                }
            }
        }
    }

    #[test]
    fn every_single_ascii_byte_mutation_is_total_and_strict() {
        let suffix = valid_suffix();

        for index in 0..MANAGED_SUFFIX_LEN {
            for replacement in 0_u8..=u8::MAX {
                let mut mutated = suffix.clone().into_bytes();
                mutated[index] = replacement;
                let value = String::from_utf8_lossy(&mutated);
                let result =
                    catch_unwind(AssertUnwindSafe(|| parse_managed_hex_components(&value)));

                assert!(
                    result.is_ok(),
                    "parser panicked at byte {index} with replacement {replacement:#04x}"
                );
                let replacement_is_valid = if index == SEPARATOR_INDEX {
                    replacement == b'-'
                } else {
                    is_lower_hex_byte(replacement)
                };
                assert_eq!(result.expect("no panic").is_some(), replacement_is_valid);
            }
        }
    }
}
