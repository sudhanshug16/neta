"""Lex and inspect bounded GitHub Actions expression spans."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from enum import Enum


@dataclass(frozen=True)
class ActionsExpression:
    start: int
    end: int
    body: str


@dataclass(frozen=True)
class ExpressionScan:
    end: int
    expression: ActionsExpression | None


def _single_quoted_end(text: str, start: int) -> tuple[int, bool]:
    index = start + 1
    while index < len(text):
        if text[index] != "'":
            index += 1
            continue
        if index + 1 < len(text) and text[index + 1] == "'":
            index += 2
            continue
        return index + 1, True
    return len(text), False


def _double_quoted_end(text: str, start: int) -> tuple[int, bool]:
    index = start + 1
    while index < len(text):
        if text[index] == "\\":
            index = min(len(text), index + 2)
            continue
        if text[index] == '"':
            return index + 1, True
        index += 1
    return len(text), False


def scan_actions_expression(text: str, start: int) -> ExpressionScan | None:
    """Scan one expression without crossing its scalar's finite text."""

    if not text.startswith("${{", start):
        return None

    body_start = start + 3
    index = body_start
    expected_closers: list[str] = []
    valid = True
    opener_to_closer = {"(": ")", "[": "]", "{": "}"}
    closers = frozenset(opener_to_closer.values())

    while index < len(text):
        character = text[index]
        if character == "'":
            index, closed = _single_quoted_end(text, index)
            if not closed:
                return ExpressionScan(len(text), None)
            continue
        if character == '"':
            # Actions expression string literals use single quotes. Consume a
            # double-quoted region only to keep its delimiters bounded, then
            # reject the expression instead of repairing invalid syntax.
            valid = False
            index, closed = _double_quoted_end(text, index)
            if not closed:
                return ExpressionScan(len(text), None)
            continue
        if text.startswith("${{", index):
            valid = False
            index += 3
            continue
        if text.startswith("}}", index):
            if not expected_closers:
                end = index + 2
                expression = (
                    ActionsExpression(start, end, text[body_start:index])
                    if valid
                    else None
                )
                return ExpressionScan(end, expression)
            if expected_closers[-1] != "}":
                return ExpressionScan(index + 2, None)
            expected_closers.pop()
            index += 1
            continue
        if character in opener_to_closer:
            expected_closers.append(opener_to_closer[character])
        elif character in closers:
            if not expected_closers or expected_closers[-1] != character:
                valid = False
            else:
                expected_closers.pop()
        index += 1

    return ExpressionScan(len(text), None)


def iter_actions_expressions(text: str) -> Iterator[ActionsExpression]:
    """Yield closed, lexically valid expression spans in source order."""

    index = 0
    while index < len(text):
        start = text.find("${{", index)
        if start < 0:
            return
        scanned = scan_actions_expression(text, start)
        if scanned is None:
            index = start + 3
            continue
        if scanned.expression is not None:
            yield scanned.expression
        index = max(start + 3, scanned.end)


class _TokenKind(Enum):
    IDENTIFIER = "identifier"
    STRING = "string"
    DOT = "dot"
    OPEN_BRACKET = "open-bracket"
    CLOSE_BRACKET = "close-bracket"
    OTHER = "other"


@dataclass(frozen=True)
class _Token:
    kind: _TokenKind
    value: str


def _expression_tokens(body: str) -> tuple[_Token, ...]:
    tokens: list[_Token] = []
    index = 0
    while index < len(body):
        character = body[index]
        if character.isspace():
            index += 1
            continue
        if character == "'":
            index += 1
            value: list[str] = []
            while index < len(body):
                if body[index] != "'":
                    value.append(body[index])
                    index += 1
                    continue
                if index + 1 < len(body) and body[index + 1] == "'":
                    value.append("'")
                    index += 2
                    continue
                index += 1
                break
            tokens.append(_Token(_TokenKind.STRING, "".join(value)))
            continue
        if character.isalpha() or character == "_":
            start = index
            index += 1
            while index < len(body) and (body[index].isalnum() or body[index] == "_"):
                index += 1
            tokens.append(_Token(_TokenKind.IDENTIFIER, body[start:index]))
            continue
        kind = {
            ".": _TokenKind.DOT,
            "[": _TokenKind.OPEN_BRACKET,
            "]": _TokenKind.CLOSE_BRACKET,
        }.get(character, _TokenKind.OTHER)
        tokens.append(_Token(kind, character))
        index += 1
    return tuple(tokens)


def _property_name(tokens: tuple[_Token, ...], start: int) -> tuple[str, int] | None:
    if (
        start + 1 < len(tokens)
        and tokens[start].kind is _TokenKind.DOT
        and tokens[start + 1].kind is _TokenKind.IDENTIFIER
    ):
        return tokens[start + 1].value, start + 2
    if (
        start + 2 < len(tokens)
        and tokens[start].kind is _TokenKind.OPEN_BRACKET
        and tokens[start + 1].kind is _TokenKind.STRING
        and tokens[start + 2].kind is _TokenKind.CLOSE_BRACKET
    ):
        return tokens[start + 1].value, start + 3
    return None


def _is_root_reference(tokens: tuple[_Token, ...], index: int) -> bool:
    return index == 0 or tokens[index - 1].kind is not _TokenKind.DOT


def find_actions_input_context(body: str) -> str | None:
    """Return the first direct `inputs` context referenced by an expression."""

    tokens = _expression_tokens(body)
    for index, token in enumerate(tokens):
        if token.kind is not _TokenKind.IDENTIFIER:
            continue
        if token.value == "github" and _is_root_reference(tokens, index):
            event = _property_name(tokens, index + 1)
            if event is not None and event[0] == "event":
                inputs = _property_name(tokens, event[1])
                if inputs is not None and inputs[0] == "inputs":
                    return "github.event.inputs"
        if token.value == "inputs" and _is_root_reference(tokens, index):
            return "inputs"
    return None
