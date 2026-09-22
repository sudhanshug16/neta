use ratatui::buffer::Buffer;

pub(super) fn buffer_to_plain_string(buffer: &Buffer) -> String {
    let mut output = String::new();
    let area = buffer.area;

    for y in area.top()..area.bottom() {
        let last = (area.left()..area.right())
            .rev()
            .find(|x| buffer[(*x, y)].symbol() != " ");
        let Some(last) = last else {
            output.push('\n');
            continue;
        };

        for x in area.left()..=last {
            output.push_str(buffer[(x, y)].symbol());
        }
        output.push('\n');
    }

    output
}

#[cfg(test)]
mod tests {
    use ratatui::{buffer::Buffer, layout::Rect, style::Color};

    use super::buffer_to_plain_string;

    #[test]
    fn ignores_styles_and_preserves_symbols() {
        let mut buffer = Buffer::empty(Rect::new(0, 0, 4, 1));
        buffer[(0, 0)].set_symbol("A").set_fg(Color::LightRed);
        buffer[(1, 0)].set_symbol("B").set_bg(Color::LightBlue);

        let output = buffer_to_plain_string(&buffer);

        assert_eq!(output, "AB\n");
        assert!(!output.contains('\x1b'));
    }
}
