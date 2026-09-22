"""Structured extraction of `run` scalar nodes from Actions YAML."""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from enum import Enum

from workflow_actions_expression import scan_actions_expression


class ScalarStyle(Enum):
    PLAIN = "plain"
    SINGLE_QUOTED = "single-quoted"
    DOUBLE_QUOTED = "double-quoted"
    LITERAL = "literal"
    FOLDED = "folded"
    FLOW_PLAIN = "flow-plain"
    FLOW_SINGLE_QUOTED = "flow-single-quoted"
    FLOW_DOUBLE_QUOTED = "flow-double-quoted"


@dataclass(frozen=True)
class RunScalar:
    line: int
    value: str
    style: ScalarStyle
    start: int
    end: int

    def expression_source(self) -> str:
        """Return the scalar text GitHub inspects for expression spans."""

        if self.style in (
            ScalarStyle.SINGLE_QUOTED,
            ScalarStyle.FLOW_SINGLE_QUOTED,
        ):
            return self.value[1:-1].replace("''", "'")
        return self.value


@dataclass(frozen=True)
class _SourceLine:
    number: int
    start: int
    content: str

    @property
    def end(self) -> int:
        return self.start + len(self.content)

    @property
    def indent(self) -> int:
        return len(self.content) - len(self.content.lstrip(" "))


@dataclass(frozen=True)
class _BlockEntry:
    key: str
    key_column: int
    value_start: int
    value: str


@dataclass(frozen=True)
class _QuotedSpan:
    end: int
    closed: bool


def _source_lines(text: str) -> tuple[_SourceLine, ...]:
    lines: list[_SourceLine] = []
    offset = 0
    for number, raw in enumerate(text.splitlines(keepends=True), start=1):
        content = raw
        if content.endswith("\n"):
            content = content[:-1]
            if content.endswith("\r"):
                content = content[:-1]
        elif content.endswith("\r"):
            content = content[:-1]
        lines.append(_SourceLine(number, offset, content))
        offset += len(raw)
    if text and not lines:
        lines.append(_SourceLine(1, 0, text))
    return tuple(lines)


def _quoted_span(
    text: str, start: int, quote: str, limit: int | None = None
) -> _QuotedSpan:
    boundary = len(text) if limit is None else min(len(text), limit)
    index = start + 1
    while index < boundary:
        character = text[index]
        if quote == "'":
            if character != "'":
                index += 1
                continue
            if index + 1 < boundary and text[index + 1] == "'":
                index += 2
                continue
            return _QuotedSpan(index + 1, True)
        if character == "\\":
            index = min(boundary, index + 2)
            continue
        if character == '"':
            return _QuotedSpan(index + 1, True)
        index += 1
    return _QuotedSpan(boundary, False)


def _decode_key(raw: str) -> str:
    if len(raw) < 2 or raw[0] not in "'\"" or raw[-1] != raw[0]:
        return raw.strip()
    if raw[0] == "'":
        return raw[1:-1].replace("''", "'")
    return raw[1:-1].replace(r"\"", '"').replace(r"\\", "\\")


def _block_entry(line: _SourceLine, text: str) -> _BlockEntry | None:
    content = line.content
    cursor = line.indent
    if cursor >= len(content):
        return None
    if content[cursor] == "-":
        if cursor + 1 >= len(content) or not content[cursor + 1].isspace():
            return None
        cursor += 1
        while cursor < len(content) and content[cursor] == " ":
            cursor += 1
    if cursor >= len(content) or content[cursor] in "[{":
        return None

    key_column = cursor
    if content[cursor] in "'\"":
        quote = content[cursor]
        key_start = line.start + cursor
        key_span = _quoted_span(text, key_start, quote, line.end)
        if not key_span.closed:
            return None
        raw_key = text[key_start : key_span.end]
        cursor = key_span.end - line.start
    else:
        key_start = cursor
        while cursor < len(content):
            if content[cursor] == ":" and (
                cursor + 1 == len(content) or content[cursor + 1].isspace()
            ):
                break
            cursor += 1
        if cursor >= len(content):
            return None
        raw_key = content[key_start:cursor].strip()

    while cursor < len(content) and content[cursor] == " ":
        cursor += 1
    if cursor >= len(content) or content[cursor] != ":":
        return None
    cursor += 1
    while cursor < len(content) and content[cursor] == " ":
        cursor += 1
    return _BlockEntry(
        key=_decode_key(raw_key),
        key_column=key_column,
        value_start=line.start + cursor,
        value=content[cursor:],
    )


def _block_header(value: str) -> ScalarStyle | None:
    candidate = value.strip()
    if not candidate or candidate[0] not in "|>":
        return None
    token = candidate.split(maxsplit=1)[0]
    token = token.split("#", maxsplit=1)[0]
    modifiers = token[1:]
    if any(character not in "123456789+-" for character in modifiers):
        return None
    if sum(character.isdigit() for character in modifiers) > 1:
        return None
    if modifiers.count("+") > 1 or modifiers.count("-") > 1:
        return None
    return ScalarStyle.LITERAL if token[0] == "|" else ScalarStyle.FOLDED


def _plain_without_comment(value: str) -> str:
    for index, character in enumerate(value):
        if character == "#" and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    return value.rstrip()


def _indented_end(lines: tuple[_SourceLine, ...], start: int, key_column: int) -> int:
    index = start
    while index < len(lines):
        line = lines[index]
        if line.content.strip() and line.indent <= key_column:
            break
        index += 1
    return index


def _line_index_for_offset(lines: tuple[_SourceLine, ...], offset: int) -> int:
    starts = [line.start for line in lines]
    return max(0, bisect_right(starts, max(0, offset - 1)) - 1)


def _block_run_scalars(
    text: str, lines: tuple[_SourceLine, ...]
) -> tuple[list[RunScalar], list[tuple[int, int]]]:
    nodes: list[RunScalar] = []
    excluded: list[tuple[int, int]] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        entry = _block_entry(line, text)
        if entry is None:
            index += 1
            continue

        header_style = _block_header(entry.value)
        if header_style is not None:
            end_index = _indented_end(lines, index + 1, entry.key_column)
            body_start = lines[index + 1].start if index + 1 < end_index else line.end
            body_end = lines[end_index - 1].end if index + 1 < end_index else line.end
            excluded.append((entry.value_start, body_end))
            if entry.key == "run":
                nodes.append(
                    RunScalar(
                        line=line.number,
                        value=text[body_start:body_end],
                        style=header_style,
                        start=body_start,
                        end=body_end,
                    )
                )
            index = end_index
            continue

        if entry.value.startswith(("'", '"')):
            quote = entry.value[0]
            end_index = _indented_end(lines, index + 1, line.indent)
            scalar_limit = (
                lines[end_index - 1].end if end_index > index + 1 else line.end
            )
            scalar_span = _quoted_span(text, entry.value_start, quote, scalar_limit)
            excluded.append((entry.value_start, scalar_span.end))
            if entry.key == "run" and scalar_span.closed:
                style = (
                    ScalarStyle.SINGLE_QUOTED
                    if quote == "'"
                    else ScalarStyle.DOUBLE_QUOTED
                )
                nodes.append(
                    RunScalar(
                        line=line.number,
                        value=text[entry.value_start : scalar_span.end],
                        style=style,
                        start=entry.value_start,
                        end=scalar_span.end,
                    )
                )
            index = _line_index_for_offset(lines, scalar_span.end) + 1
            continue

        if entry.key != "run":
            index += 1
            continue

        end_index = _indented_end(lines, index + 1, entry.key_column)
        pieces = [_plain_without_comment(entry.value)]
        for continuation in lines[index + 1 : end_index]:
            pieces.append(_plain_without_comment(continuation.content))
        scalar_end = lines[end_index - 1].end if end_index > index + 1 else line.end
        excluded.append((entry.value_start, scalar_end))
        nodes.append(
            RunScalar(
                line=line.number,
                value="\n".join(pieces),
                style=ScalarStyle.PLAIN,
                start=entry.value_start,
                end=scalar_end,
            )
        )
        index = end_index
    return nodes, excluded


class _FlowScanner:
    def __init__(
        self,
        text: str,
        lines: tuple[_SourceLine, ...],
        excluded: list[tuple[int, int]],
    ) -> None:
        self.text = text
        self.lines = lines
        self.line_starts = [line.start for line in lines]
        self.excluded = sorted(excluded)
        self.nodes: list[RunScalar] = []

    def _line(self, offset: int) -> int:
        return bisect_right(self.line_starts, offset)

    def _excluded_end(self, offset: int) -> int | None:
        for start, end in self.excluded:
            if end <= offset:
                continue
            if start <= offset < end:
                return end
            if start > offset:
                return None
        return None

    def _flow_limit(self, offset: int) -> int:
        line_index = _line_index_for_offset(self.lines, offset)
        line = self.lines[line_index]
        end_index = _indented_end(self.lines, line_index + 1, line.indent)
        return self.lines[end_index - 1].end if end_index > line_index + 1 else line.end

    def _skip_expression(self, index: int) -> int:
        scanned = scan_actions_expression(self.text, index)
        return index if scanned is None else scanned.end

    def _skip_trivia(self, index: int) -> int:
        while index < len(self.text):
            excluded_end = self._excluded_end(index)
            if excluded_end is not None:
                index = excluded_end
                continue
            if self.text[index].isspace():
                index += 1
                continue
            if self.text[index] == "#":
                newline = self.text.find("\n", index + 1)
                index = len(self.text) if newline < 0 else newline + 1
                continue
            break
        return index

    def _key(self, index: int) -> tuple[str | None, int]:
        index = self._skip_trivia(index)
        if index >= len(self.text):
            return None, index
        if self.text[index] in "'\"":
            span = _quoted_span(self.text, index, self.text[index])
            if not span.closed:
                return None, span.end
            key = _decode_key(self.text[index : span.end])
            index = self._skip_trivia(span.end)
        else:
            start = index
            while index < len(self.text) and self.text[index] not in ":,}":
                index += 1
            key = self.text[start:index].strip()
        if index >= len(self.text) or self.text[index] != ":":
            return None, index
        return key, index + 1

    def _sequence(self, index: int) -> int:
        index += 1
        while index < len(self.text):
            index = self._skip_trivia(index)
            if index >= len(self.text) or self.text[index] == "]":
                return min(len(self.text), index + 1)
            index = self._value_end(index, ",]")
            index = self._skip_trivia(index)
            if index < len(self.text) and self.text[index] == ",":
                index += 1
        return index

    def _mapping(self, index: int) -> int:
        flow_limit = self._flow_limit(index)
        index += 1
        while index < len(self.text):
            index = self._skip_trivia(index)
            if index >= len(self.text) or self.text[index] == "}":
                return min(len(self.text), index + 1)
            key_start = index
            key, value_start = self._key(index)
            if key is None:
                return index + 1
            value_start = self._skip_trivia(value_start)
            quoted_span = (
                _quoted_span(
                    self.text,
                    value_start,
                    self.text[value_start],
                    flow_limit,
                )
                if value_start < len(self.text) and self.text[value_start] in "'\""
                else None
            )
            if quoted_span is not None and not quoted_span.closed:
                return quoted_span.end
            value_end = self._value_end(value_start, ",}")
            if key == "run" and (quoted_span is None or quoted_span.closed):
                if value_start < len(self.text) and self.text[value_start] == "'":
                    style = ScalarStyle.FLOW_SINGLE_QUOTED
                elif value_start < len(self.text) and self.text[value_start] == '"':
                    style = ScalarStyle.FLOW_DOUBLE_QUOTED
                else:
                    style = ScalarStyle.FLOW_PLAIN
                self.nodes.append(
                    RunScalar(
                        line=self._line(key_start),
                        value=self.text[value_start:value_end],
                        style=style,
                        start=value_start,
                        end=value_end,
                    )
                )
            index = self._skip_trivia(value_end)
            if index < len(self.text) and self.text[index] == ",":
                index += 1
        return index

    def _value_end(self, index: int, terminators: str) -> int:
        while index < len(self.text):
            excluded_end = self._excluded_end(index)
            if excluded_end is not None:
                index = excluded_end
                continue
            expression_end = self._skip_expression(index)
            if expression_end != index:
                index = expression_end
                continue
            character = self.text[index]
            if character in "'\"":
                index = _quoted_span(self.text, index, character).end
                continue
            if character == "{":
                index = self._mapping(index)
                continue
            if character == "[":
                index = self._sequence(index)
                continue
            if character in terminators:
                return index
            if character == "#":
                newline = self.text.find("\n", index + 1)
                index = len(self.text) if newline < 0 else newline + 1
                continue
            index += 1
        return index

    def scan(self) -> list[RunScalar]:
        index = 0
        while index < len(self.text):
            excluded_end = self._excluded_end(index)
            if excluded_end is not None:
                index = excluded_end
                continue
            expression_end = self._skip_expression(index)
            if expression_end != index:
                index = expression_end
                continue
            character = self.text[index]
            if character in "'\"":
                index = _quoted_span(self.text, index, character).end
                continue
            if character == "#":
                newline = self.text.find("\n", index + 1)
                index = len(self.text) if newline < 0 else newline + 1
                continue
            if character == "{":
                index = self._mapping(index)
                continue
            if character == "[":
                index = self._sequence(index)
                continue
            index += 1
        return self.nodes


def parse_run_scalars(text: str) -> tuple[RunScalar, ...]:
    """Return structured `run` scalar nodes in source order."""

    lines = _source_lines(text)
    block_nodes, excluded = _block_run_scalars(text, lines)
    flow_nodes = _FlowScanner(text, lines, excluded).scan()
    unique = {node.start: node for node in (*block_nodes, *flow_nodes)}
    return tuple(sorted(unique.values(), key=lambda node: node.start))
