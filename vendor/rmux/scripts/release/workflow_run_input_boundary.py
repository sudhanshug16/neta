"""Detect untrusted Actions input contexts embedded in shell source."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

from workflow_actions_expression import (
    find_actions_input_context,
    iter_actions_expressions,
)
from workflow_yaml_run_scalars import parse_run_scalars


@dataclass(frozen=True)
class DirectInputExpression:
    run_line: int
    context: str


def iter_run_scalars(text: str) -> Iterator[tuple[int, str]]:
    """Yield line number and value from structured YAML scalar nodes."""

    for scalar in parse_run_scalars(text):
        yield scalar.line, scalar.expression_source()


def find_direct_input_expressions(text: str) -> tuple[DirectInputExpression, ...]:
    findings: list[DirectInputExpression] = []
    for run_line, scalar in iter_run_scalars(text):
        for expression in iter_actions_expressions(scalar):
            context = find_actions_input_context(expression.body)
            if context is None:
                continue
            findings.append(DirectInputExpression(run_line, context))
    return tuple(findings)


def validate_no_direct_input_expressions(paths: Iterable[Path]) -> None:
    findings: list[str] = []
    for path in paths:
        for finding in find_direct_input_expressions(path.read_text(encoding="utf-8")):
            findings.append(f"{path}:{finding.run_line} ({finding.context})")
    if findings:
        locations = ", ".join(findings)
        raise ValueError(
            "Actions input context is embedded directly in retry shell source: "
            f"{locations}"
        )
