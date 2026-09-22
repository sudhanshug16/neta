use ratatui::style::Color;
use rmux_proto::{CommandOutput, WebShareCreatedResponse, WebShareScope};

use super::qr;
use super::support::{url_label, LinkMode, OutputStyle, UrlLabel};
use super::{
    cards_fit_width, created_share_terminal_output, full_links_output,
    full_links_output_with_copy_fallback, render_created_share_with_style, should_stack_cards,
    ShareCard,
};

#[test]
fn created_output_includes_distinct_role_pins() {
    let created = WebShareCreatedResponse {
        share_id: "abc12345".to_owned(),
        scope: WebShareScope::Session("demo".parse().expect("session")),
        spectator_url: Some("https://share.rmux.io/#t=spectator".to_owned()),
        operator_url: Some("https://share.rmux.io/#t=operator".to_owned()),
        tunnel_provider: Some("NAME".to_owned()),
        tunnel_public_url: None,
        expires_at_unix: None,
        operator_pairing_code: Some("123456".to_owned()),
        spectator_pairing_code: Some("654321".to_owned()),
        max_spectators: Some(12),
        max_operators: Some(1),
        operator: true,
        spectator: true,
        controls: true,
        kill_session_on_expire: false,
        output: CommandOutput::from_stdout(Vec::new()),
    };

    let rendered = String::from_utf8(created_share_terminal_output(&created).stdout().to_vec())
        .expect("utf8 output");
    let visible = strip_ansi(&rendered);

    assert!(visible.contains("123456"));
    assert!(visible.contains("654321"));
    assert!(!visible.contains("123 456"));
    assert!(!visible.contains("654 321"));
    assert!(visible.contains("share.rmux.io is static"));
}

#[test]
fn plain_terminal_urls_that_do_not_fit_are_printed_below() {
    let url =
        "https://share.rmux.io/#t=abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz";
    let card = ShareCard {
        title: "SPECTATOR",
        subtitle: "read-only view",
        color: Color::LightBlue,
        url,
        pin: Some("654321"),
        limit: None,
    };

    assert_eq!(
        url_label(url, 40, LinkMode::PlainUrl),
        UrlLabel::PrintedBelow
    );
    let links = full_links_output(52, &[card], LinkMode::PlainUrl);

    assert!(links.contains("Full web-share URLs:"));
    assert!(links.contains(url));
    assert!(!links.contains('…'));
}

#[test]
fn osc8_compact_urls_are_printed_below_as_copy_fallback() {
    let url = "https://share.rmux.io/#e=wss%3A%2F%2Ftail.example%2Fws&t=abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz";
    let card = ShareCard {
        title: "SPECTATOR",
        subtitle: "read-only view",
        color: Color::LightBlue,
        url,
        pin: None,
        limit: None,
    };

    let links = full_links_output(52, &[card], LinkMode::Osc8);

    assert!(links.contains("Full web-share URLs:"));
    assert!(links.contains(url));
    assert!(!links.contains('…'));
}

#[test]
fn terminal_fallback_prints_raw_links_even_when_card_urls_fit() {
    let url = "https://share.rmux.io/#t=abcdefghijklmnopqrstuvwxyz0123456789";
    let card = ShareCard {
        title: "SPECTATOR",
        subtitle: "read-only view",
        color: Color::LightBlue,
        url,
        pin: None,
        limit: None,
    };

    assert!(full_links_output_with_copy_fallback(
        120,
        std::slice::from_ref(&card),
        LinkMode::PlainUrl,
        false
    )
    .is_empty());

    let links = full_links_output_with_copy_fallback(120, &[card], LinkMode::PlainUrl, true);
    assert!(links.contains("Full web-share URLs:"));
    assert!(links.contains(url));
}

#[test]
fn plain_output_contains_no_ansi_and_keeps_scannable_qr() {
    let created = WebShareCreatedResponse {
        share_id: "abc12345".to_owned(),
        scope: WebShareScope::Session("demo".parse().expect("session")),
        spectator_url: Some("https://share.rmux.io/#t=spectator".to_owned()),
        operator_url: Some("https://share.rmux.io/#t=operator".to_owned()),
        tunnel_provider: Some("NAME".to_owned()),
        tunnel_public_url: None,
        expires_at_unix: None,
        operator_pairing_code: Some("123456".to_owned()),
        spectator_pairing_code: Some("654321".to_owned()),
        max_spectators: None,
        max_operators: None,
        operator: true,
        spectator: true,
        controls: true,
        kill_session_on_expire: false,
        output: CommandOutput::from_stdout(Vec::new()),
    };

    let rendered =
        render_created_share_with_style(&created, OutputStyle::Plain).expect("plain render");

    assert!(!rendered.contains('\x1b'));
    assert!(rendered.contains('█'));
    assert!(rendered.contains("operator: https://share.rmux.io/#t=operator"));
    assert!(rendered.contains("spectator: https://share.rmux.io/#t=spectator"));
}

#[test]
fn plain_long_urls_do_not_force_stacked_cards_on_wide_terminals() {
    let operator_url = "https://share.rmux.io/#t=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK";
    let spectator_url = "https://share.rmux.io/#t=0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJK";
    let cards = [
        ShareCard {
            title: "OPERATOR",
            subtitle: "control + type",
            color: Color::LightRed,
            url: operator_url,
            pin: None,
            limit: None,
        },
        ShareCard {
            title: "SPECTATOR",
            subtitle: "read-only view",
            color: Color::LightBlue,
            url: spectator_url,
            pin: None,
            limit: None,
        },
    ];

    assert!(!should_stack_cards(108, &cards, LinkMode::PlainUrl));
}

#[test]
fn narrow_single_card_rejects_truncated_qr_width() {
    let url = "https://share.rmux.io/#e=wss%3A%2F%2Ftunnel.example%2Fws&t=abcdefghijklmnopqrstuvwxyz0123456789";
    let card = ShareCard {
        title: "SPECTATOR",
        subtitle: "read-only view",
        color: Color::LightBlue,
        url,
        pin: None,
        limit: None,
    };

    assert!(!cards_fit_width(
        44,
        std::slice::from_ref(&card),
        qr::RenderMode::Compact
    ));
    assert!(cards_fit_width(54, &[card], qr::RenderMode::Compact));
}

#[test]
fn created_output_uses_custom_frontend_host() {
    let created = WebShareCreatedResponse {
        share_id: "abc12345".to_owned(),
        scope: WebShareScope::Session("demo".parse().expect("session")),
        spectator_url: Some("https://share.fork.example/share/#t=spectator".to_owned()),
        operator_url: None,
        tunnel_provider: None,
        tunnel_public_url: None,
        expires_at_unix: None,
        operator_pairing_code: None,
        spectator_pairing_code: Some("654321".to_owned()),
        max_spectators: None,
        max_operators: None,
        operator: false,
        spectator: true,
        controls: false,
        kill_session_on_expire: false,
        output: CommandOutput::from_stdout(Vec::new()),
    };

    let rendered = String::from_utf8(created_share_terminal_output(&created).stdout().to_vec())
        .expect("utf8 output");
    let visible = strip_ansi(&rendered);

    assert!(visible.contains("share.fork.example is static"));
    assert!(!visible.contains("share.rmux.io is static"));
}

fn strip_ansi(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            output.push(ch);
            continue;
        }
        match chars.peek().copied() {
            Some(']') => {
                chars.next();
                while let Some(ch) = chars.next() {
                    if ch == '\x07' {
                        break;
                    }
                    if ch == '\x1b' && chars.next_if_eq(&'\\').is_some() {
                        break;
                    }
                }
            }
            Some('[') => {
                chars.next();
                for ch in chars.by_ref() {
                    if ('@'..='~').contains(&ch) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    output
}
