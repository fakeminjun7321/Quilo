#!/usr/bin/env python3
r"""
Insert Hancom/HWPX equation objects into an existing .hwpx file.

Recommended AI workflow:
  1. Put placeholders in the HWPX body text:
       {{EQ:x = {-b +- sqrt {b^2 - 4ac}} over {2a}}}
  2. Run:
       python hwpx_equation_tool.py replace input.hwpx output.hwpx

The expression inside EQ is Hancom Equation Editor script, not LaTeX.
For common LaTeX snippets, use EQ-LATEX:
       {{EQ-LATEX:\frac{-b \pm \sqrt{b^2-4ac}}{2a}}}

For automatically numbered equations, use EQN or EQN-LATEX:
       {{EQN:x^2 + y^2 = z^2}}
"""

from __future__ import annotations

import argparse
import copy
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HS_NS = "http://www.hancom.co.kr/hwpml/2011/section"

NS = {
    "hp": HP_NS,
    "hs": HS_NS,
    "hh": "http://www.hancom.co.kr/hwpml/2011/head",
    "hc": "http://www.hancom.co.kr/hwpml/2011/core",
    "ha": "http://www.hancom.co.kr/hwpml/2011/app",
    "hp10": "http://www.hancom.co.kr/hwpml/2016/paragraph",
    "config": "urn:oasis:names:tc:opendocument:xmlns:config:1.0",
}

XMLNS_RE = re.compile(rb'\sxmlns(?::([A-Za-z_][\w.-]*))?="([^"]+)"')


def qname(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


def register_known_namespaces() -> None:
    for prefix, uri in NS.items():
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            pass


def register_namespaces_from_xml(xml_bytes: bytes) -> None:
    """Preserve existing prefixes as much as ElementTree allows."""
    register_known_namespaces()
    for prefix_b, uri_b in XMLNS_RE.findall(xml_bytes[:12000]):
        prefix = prefix_b.decode("utf-8") if prefix_b else ""
        uri = uri_b.decode("utf-8")
        if prefix.lower().startswith("xml"):
            continue
        try:
            ET.register_namespace(prefix, uri)
        except ValueError:
            continue


@dataclass(frozen=True)
class EquationStyle:
    base_unit: int = 1000
    text_color: str = "#000000"
    line_thickness: int = 100
    letter_spacing: int = 0


@dataclass
class ReplacementContext:
    next_equation_number: int = 1


class IdGenerator:
    def __init__(self, root: ET.Element, start: int = 1000000) -> None:
        used: set[str] = set()
        max_numeric = start - 1
        for elem in root.iter():
            value = elem.attrib.get("id")
            if value is None:
                continue
            used.add(value)
            if value.isdigit():
                max_numeric = max(max_numeric, int(value))
        self._used = used
        self._next = max_numeric + 1

    def next(self) -> str:
        while str(self._next) in self._used:
            self._next += 1
        value = str(self._next)
        self._used.add(value)
        self._next += 1
        return value


def make_text_run(text: str, run_attrs: dict[str, str]) -> ET.Element:
    run = ET.Element(qname(HP_NS, "run"), run_attrs)
    t = ET.SubElement(run, qname(HP_NS, "t"))
    t.text = text
    return run


def make_equation(
    script: str,
    equation_id: str,
    style: EquationStyle = EquationStyle(),
    treat_as_char: bool = True,
) -> ET.Element:
    equation = ET.Element(
        qname(HP_NS, "equation"),
        {
            "id": equation_id,
            "type": "0",
            "textColor": style.text_color,
            "baseUnit": str(style.base_unit),
            "letterSpacing": str(style.letter_spacing),
            "lineThickness": str(style.line_thickness),
            # Hancom can recalculate this when the file opens.
            "baseLine": "0",
        },
    )
    ET.SubElement(
        equation,
        qname(HP_NS, "sz"),
        {
            "width": "0",
            "height": "0",
            "widthRelTo": "ABS",
            "heightRelTo": "ABS",
        },
    )
    ET.SubElement(
        equation,
        qname(HP_NS, "pos"),
        {
            "treatAsChar": "1" if treat_as_char else "0",
            "affectLSpacing": "0",
            "flowWithText": "0",
            "allowOverlap": "0",
            "holdAnchorAndSO": "0",
            "rgroupWithPrevCtrl": "0",
            "vertRelTo": "PARA",
            "horzRelTo": "PARA",
            "vertAlign": "TOP",
            "horzAlign": "LEFT",
            "vertOffset": "0",
            "horzOffset": "0",
        },
    )
    script_elem = ET.SubElement(equation, qname(HP_NS, "script"))
    script_elem.text = script.strip()
    return equation


def make_equation_run(
    script: str,
    equation_id: str,
    run_attrs: dict[str, str],
    style: EquationStyle = EquationStyle(),
) -> ET.Element:
    run = ET.Element(qname(HP_NS, "run"), run_attrs)
    run.append(make_equation(script, equation_id, style=style))
    return run


class LatexToHwpConverter:
    """Small, practical converter for common math snippets.

    This is intentionally not a full TeX parser. It covers the patterns that
    show up most often in AI-generated equations and leaves plain text intact.
    """

    COMMANDS = {
        r"\times": " TIMES ",
        r"\cdot": " TIMES ",
        r"\div": " DIV ",
        r"\pm": "+-",
        r"\mp": "-+",
        r"\approx": " APPROX ",
        r"\equiv": "==",
        r"\leq": "<=",
        r"\le": "<=",
        r"\geq": ">=",
        r"\ge": ">=",
        r"\neq": "!=",
        r"\ne": "!=",
        r"\rightarrow": "->",
        r"\Rightarrow": "=>",
        r"\leftarrow": "<-",
        r"\Leftarrow": "<=",
        r"\leftrightarrow": "<->",
        r"\to": "->",
        r"\infty": "INF",
        r"\partial": "partial",
        r"\nabla": "nabla",
        r"\forall": "forall",
        r"\exists": "exists",
        r"\in": "in",
        r"\notin": "notin",
        r"\cup": "cup",
        r"\cap": "cap",
        r"\subset": "subset",
        r"\subseteq": "subseteq",
        r"\supset": "supset",
        r"\supseteq": "supseteq",
        r"\pi": "pi",
        r"\varepsilon": "epsilon",
        r"\epsilon": "epsilon",
        r"\vartheta": "theta",
        r"\theta": "theta",
        r"\varphi": "phi",
        r"\varrho": "rho",
        r"\varsigma": "sigma",
        r"\alpha": "alpha",
        r"\beta": "beta",
        r"\gamma": "gamma",
        r"\delta": "delta",
        r"\eta": "eta",
        r"\zeta": "zeta",
        r"\iota": "iota",
        r"\kappa": "kappa",
        r"\Delta": "DELTA",
        r"\lambda": "lambda",
        r"\mu": "mu",
        r"\nu": "nu",
        r"\xi": "xi",
        r"\rho": "rho",
        r"\sigma": "sigma",
        r"\tau": "tau",
        r"\upsilon": "upsilon",
        r"\Sigma": "SIGMA",
        r"\phi": "phi",
        r"\chi": "chi",
        r"\psi": "psi",
        r"\omega": "omega",
        r"\Gamma": "GAMMA",
        r"\Theta": "THETA",
        r"\Lambda": "LAMBDA",
        r"\Xi": "XI",
        r"\Pi": "PI",
        r"\Omega": "OMEGA",
        r"\Phi": "PHI",
        r"\Psi": "PSI",
        r"\sin": "sin",
        r"\cos": "cos",
        r"\tan": "tan",
        r"\cot": "cot",
        r"\sec": "sec",
        r"\csc": "csc",
        r"\arcsin": "arcsin",
        r"\arccos": "arccos",
        r"\arctan": "arctan",
        r"\sinh": "sinh",
        r"\cosh": "cosh",
        r"\tanh": "tanh",
        r"\log": "log",
        r"\ln": "ln",
        r"\exp": "exp",
        r"\min": "min",
        r"\max": "max",
        r"\lim": "lim",
        r"\sum": "sum",
        r"\prod": "prod",
        r"\int": "int",
        r"\iint": "iint",
        r"\iiint": "iiint",
        r"\left": "",
        r"\right": "",
        r"\,": "`",
        r"\;": "~",
        r"\quad": "~",
        r"\qquad": "~ ~",
    }

    ONE_ARG_COMMANDS = {
        r"\overline": "bar",
        r"\bar": "bar",
        r"\vec": "vec",
        r"\hat": "hat",
        r"\widehat": "hat",
        r"\tilde": "tilde",
        r"\widetilde": "tilde",
        r"\dot": "dot",
        r"\ddot": "ddot",
        r"\mathrm": "",
        r"\mathbf": "",
        r"\mathit": "",
        r"\text": "",
    }

    ENVIRONMENTS = {
        "matrix": "matrix",
        "pmatrix": "pmatrix",
        "bmatrix": "bmatrix",
        "vmatrix": "vmatrix",
        "Vmatrix": "Vmatrix",
        "cases": "cases",
        "aligned": "matrix",
        "array": "matrix",
    }

    def convert(self, latex: str) -> str:
        text = latex.strip()
        text = self._strip_math_delimiters(text)
        text = self._convert_structures(text)
        for src, dst in sorted(self.COMMANDS.items(), key=lambda item: -len(item[0])):
            text = text.replace(src, dst)
        text = text.replace(r"\{", "{").replace(r"\}", "}")
        text = text.replace(r"\%", "%")
        text = text.replace(r"\_", "_")
        text = re.sub(r"\b(sum|prod|int|iint|iiint|lim)(?=[_^])", r"\1 ", text)
        text = re.sub(r"\s+", " ", text)
        text = re.sub(r"\s+([_^])", r"\1", text)
        return text.strip()

    def _strip_math_delimiters(self, text: str) -> str:
        pairs = [
            (r"\(", r"\)"),
            (r"\[", r"\]"),
            ("$$", "$$"),
            ("$", "$"),
        ]
        for left, right in pairs:
            if text.startswith(left) and text.endswith(right):
                return text[len(left) : len(text) - len(right)].strip()
        return text

    def _convert_structures(self, text: str) -> str:
        previous = None
        current = text
        while previous != current:
            previous = current
            current = self._replace_labeled_arrows(current)
            current = self._replace_environments(current)
            current = self._replace_frac(current)
            current = self._replace_sqrt(current)
            current = self._replace_binom(current)
            current = self._replace_one_arg_commands(current)
        return current

    def _replace_labeled_arrows(self, text: str) -> str:
        arrows = (
            (r"\xleftrightarrow", "<->"),
            (r"\xrightarrow", "->"),
            (r"\xleftarrow", "<-"),
        )
        for marker, arrow in arrows:
            idx = text.find(marker)
            while idx >= 0:
                pos = self._skip_spaces(text, idx + len(marker))
                below = ""
                if pos < len(text) and text[pos] == "[":
                    below, pos = self._read_balanced(text, pos, "[", "]")
                    pos = self._skip_spaces(text, pos)
                if pos >= len(text) or text[pos] != "{":
                    idx = text.find(marker, idx + len(marker))
                    continue
                above, end = self._read_balanced(text, pos, "{", "}")
                label = above.strip() or below.strip()
                converted_label = self._convert_structures(label)
                replacement = f"BUILDREL {arrow} {{{converted_label}}}"
                text = text[:idx] + replacement + text[end:]
                idx = text.find(marker, idx + len(replacement))
        return text

    def _replace_frac(self, text: str) -> str:
        for marker in (r"\dfrac", r"\tfrac", r"\frac"):
            text = self._replace_two_braced_args(text, marker, "{%s} over {%s}")
        return text

    def _replace_binom(self, text: str) -> str:
        return self._replace_two_braced_args(text, r"\binom", "{%s} binom {%s}")

    def _replace_one_arg_commands(self, text: str) -> str:
        for marker, command in sorted(
            self.ONE_ARG_COMMANDS.items(), key=lambda item: -len(item[0])
        ):
            idx = text.find(marker)
            while idx >= 0:
                pos = self._skip_spaces(text, idx + len(marker))
                if pos >= len(text) or text[pos] != "{":
                    idx = text.find(marker, idx + len(marker))
                    continue
                body, end = self._read_balanced(text, pos, "{", "}")
                converted_body = self._convert_structures(body)
                replacement = (
                    f"{command} {{{converted_body}}}" if command else converted_body
                )
                text = text[:idx] + replacement + text[end:]
                idx = text.find(marker, idx + len(replacement))
        return text

    def _replace_environments(self, text: str) -> str:
        for latex_name, hwp_name in self.ENVIRONMENTS.items():
            begin = rf"\begin{{{latex_name}}}"
            end = rf"\end{{{latex_name}}}"
            idx = text.find(begin)
            while idx >= 0:
                body_start = idx + len(begin)
                if latex_name == "array":
                    after_begin = self._skip_spaces(text, body_start)
                    if after_begin < len(text) and text[after_begin] == "{":
                        try:
                            _, body_start = self._read_balanced(
                                text, after_begin, "{", "}"
                            )
                        except ValueError:
                            body_start = after_begin
                end_idx = text.find(end, body_start)
                if end_idx < 0:
                    idx = text.find(begin, body_start)
                    continue
                body = text[body_start:end_idx]
                converted_body = self._convert_matrix_body(body)
                replacement = f"{hwp_name} {{ {converted_body} }}"
                text = text[:idx] + replacement + text[end_idx + len(end) :]
                idx = text.find(begin, idx + len(replacement))
        return text

    def _convert_matrix_body(self, body: str) -> str:
        rows = re.split(r"\\\\", body.strip())
        converted_rows: list[str] = []
        for row in rows:
            cells = [self._convert_structures(cell.strip()) for cell in row.split("&")]
            converted_rows.append(" & ".join(cells))
        return " # ".join(converted_rows)

    def _replace_sqrt(self, text: str) -> str:
        marker = r"\sqrt"
        idx = text.find(marker)
        while idx >= 0:
            pos = idx + len(marker)
            pos = self._skip_spaces(text, pos)
            degree = None
            if pos < len(text) and text[pos] == "[":
                degree, pos = self._read_balanced(text, pos, "[", "]")
                pos = self._skip_spaces(text, pos)
            if pos >= len(text) or text[pos] != "{":
                idx = text.find(marker, idx + len(marker))
                continue
            body, end = self._read_balanced(text, pos, "{", "}")
            converted_body = self._convert_structures(body)
            if degree is None:
                replacement = f"sqrt {{{converted_body}}}"
            else:
                replacement = f"root {degree.strip()} of {{{converted_body}}}"
            text = text[:idx] + replacement + text[end:]
            idx = text.find(marker, idx + len(replacement))
        return text

    def _replace_two_braced_args(self, text: str, marker: str, template: str) -> str:
        idx = text.find(marker)
        while idx >= 0:
            pos = self._skip_spaces(text, idx + len(marker))
            if pos >= len(text) or text[pos] != "{":
                idx = text.find(marker, idx + len(marker))
                continue
            first, pos = self._read_balanced(text, pos, "{", "}")
            pos = self._skip_spaces(text, pos)
            if pos >= len(text) or text[pos] != "{":
                idx = text.find(marker, idx + len(marker))
                continue
            second, end = self._read_balanced(text, pos, "{", "}")
            replacement = template % (
                self._convert_structures(first),
                self._convert_structures(second),
            )
            text = text[:idx] + replacement + text[end:]
            idx = text.find(marker, idx + len(replacement))
        return text

    def _read_balanced(
        self, text: str, start: int, opener: str, closer: str
    ) -> tuple[str, int]:
        if text[start] != opener:
            raise ValueError(f"expected {opener!r} at index {start}")
        depth = 0
        i = start
        while i < len(text):
            char = text[i]
            if char == "\\":
                i += 2
                continue
            if char == opener:
                depth += 1
            elif char == closer:
                depth -= 1
                if depth == 0:
                    return text[start + 1 : i], i + 1
            i += 1
        raise ValueError(f"unclosed {opener!r} in LaTeX expression")

    def _skip_spaces(self, text: str, pos: int) -> int:
        while pos < len(text) and text[pos].isspace():
            pos += 1
        return pos


def brace_unbraced_scripts(script: str) -> str:
    text = str(script or "")
    text = re.sub(r"([_^])(?!\{)([+\-])", r"\1{\2}", text)
    text = re.sub(r"([_^])(?!\{)(\d+(?:\.\d+)?)", r"\1{\2}", text)
    text = re.sub(r"([_^])(?!\{)([A-Za-z]+)", r"\1{\2}", text)
    return text


def compact_chemical_spacing(script: str) -> str:
    token = r"(?:[A-Z][a-z]?|\)(?:_\{[^}]+\})?)(?:_\{[^}]+\})?"
    command = r"(?:BUILDREL|TIMES|DIV|APPROX|INF|DELTA|SIGMA|GAMMA|THETA|LAMBDA|XI|PI|OMEGA|PHI|PSI)\b"
    return re.sub(
        rf"({token})\s+(?!{command})(?=[A-Z][a-z]?|\()",
        r"\1",
        str(script or ""),
    )


def quote_textual_subscripts(script: str) -> str:
    """Protect multi-letter subscript labels from HWP equation keywords.

    Hancom equation scripts treat words such as `pi` as symbols. A physics
    label like `I_{pivot}` can therefore render as `I_{πvot}` unless the label
    is entered as literal text. Numeric and single-letter subscripts remain
    mathematical variables.
    """
    def repl(match: re.Match[str]) -> str:
        body = match.group(1).strip()
        if not body or body.startswith('"') or body.startswith("'"):
            return match.group(0)
        textual_label = re.fullmatch(
            r"(?=.*[A-Za-z])[A-Za-z0-9]+(?:[,\s_-]+[A-Za-z0-9]+)*",
            body,
        )
        if textual_label and len(body) >= 2:
            return f'_{{"{body}"}}'
        return match.group(0)

    return re.sub(r"_\{([^{}]+)\}", repl, str(script or ""))


def normalize_hwp_script(script: str) -> str:
    text = str(script or "").strip()
    text = (
        text.replace("→", "->")
        .replace("⟶", "->")
        .replace("⇒", "=>")
        .replace("←", "<-")
        .replace("⇌", "<->")
        .replace("↔", "<->")
        .replace("⇄", "<->")
    )
    text = re.sub(
        r"--\s*\[\s*(?P<label>[^\]]+?)\s*\]\s*(?P<arrow><->|<=>|->|<-|=>)",
        r"BUILDREL \g<arrow> {\g<label>}",
        text,
    )
    text = re.sub(
        r"(?P<arrow><->|<=>|->|<-|=>)\s*\[\s*(?P<label>[^\]]+?)\s*\]",
        r"BUILDREL \g<arrow> {\g<label>}",
        text,
    )
    text = text.replace("<=>", "<->")
    text = re.sub(r"\s+([_^])\s*", r"\1", text)
    text = brace_unbraced_scripts(text)
    text = quote_textual_subscripts(text)
    text = compact_chemical_spacing(text)
    text = re.sub(r"\b(APPROX|TIMES|DIV)(?=[A-Za-z0-9{])", r"\1 ", text)
    text = re.sub(r"(?<=[A-Za-z0-9}])(?=(APPROX|TIMES|DIV)\b)", " ", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def placeholder_to_script(kind: str, raw_script: str) -> str:
    raw_script = raw_script.strip()
    if kind.endswith("-LATEX"):
        return normalize_hwp_script(LatexToHwpConverter().convert(raw_script))
    return normalize_hwp_script(raw_script)


def is_numbered_placeholder(kind: str) -> bool:
    return kind.startswith("EQN")


def strip_equation_markers_for_text(text: str) -> str:
    """Return a readable plain-text fallback for malformed equation markers.

    Report generation should not fail just because one model-produced
    `{{EQ:...}}` span has unbalanced braces. In that case, keep the formula text
    visible and remove the internal marker syntax so validation does not reject
    the whole HWPX file.
    """
    text = str(text or "")
    try:
        placeholders = find_equation_placeholders(text)
    except ValueError:
        placeholders = []

    if placeholders:
        parts: list[str] = []
        cursor = 0
        for placeholder in placeholders:
            parts.append(text[cursor : placeholder.start])
            parts.append(placeholder.body.strip())
            cursor = placeholder.end
        parts.append(text[cursor:])
        text = "".join(parts)

    text = re.sub(r"\{\{(?:EQN-LATEX|EQ-LATEX|EQN|EQ):", "", text)
    text = text.replace("}}", "")
    return text


@dataclass(frozen=True)
class Placeholder:
    start: int
    end: int
    kind: str
    body: str


def find_equation_placeholders(text: str, strict: bool = True) -> list[Placeholder]:
    """Find {{EQ:...}} blocks while allowing balanced braces inside the body."""
    placeholders: list[Placeholder] = []
    pos = 0
    prefixes = ("{{EQN-LATEX:", "{{EQ-LATEX:", "{{EQN:", "{{EQ:")

    while True:
        starts = [
            (text.find(prefix, pos), prefix)
            for prefix in prefixes
            if text.find(prefix, pos) >= 0
        ]
        if not starts:
            return placeholders

        start, prefix = min(starts, key=lambda item: item[0])
        body_start = start + len(prefix)
        kind = prefix[2:-1]
        depth = 0
        i = body_start

        while i < len(text):
            char = text[i]
            if char == "\\":
                i += 2
                continue
            if char == "{":
                depth += 1
                i += 1
                continue
            if char == "}":
                if depth == 0 and i + 1 < len(text) and text[i + 1] == "}":
                    placeholders.append(
                        Placeholder(start=start, end=i + 2, kind=kind, body=text[body_start:i])
                    )
                    pos = i + 2
                    break
                if depth > 0:
                    depth -= 1
                i += 1
                continue
            i += 1
        else:
            if strict:
                raise ValueError(f"Unclosed equation placeholder starting at index {start}.")
            return placeholders


def split_text_into_runs(
    text: str,
    run_attrs: dict[str, str],
    id_gen: IdGenerator,
    style: EquationStyle,
    context: ReplacementContext | None = None,
) -> tuple[list[ET.Element], int]:
    result: list[ET.Element] = []
    count = 0
    cursor = 0
    context = context or ReplacementContext()

    for placeholder in find_equation_placeholders(text):
        before = text[cursor : placeholder.start]
        if before:
            result.append(make_text_run(before, run_attrs))

        script = placeholder_to_script(placeholder.kind, placeholder.body)
        result.append(make_equation_run(script, id_gen.next(), run_attrs, style=style))
        if is_numbered_placeholder(placeholder.kind):
            number = context.next_equation_number
            context.next_equation_number += 1
            result.append(make_text_run(f" ({number})", run_attrs))
        count += 1
        cursor = placeholder.end

    after = text[cursor:]
    if after:
        result.append(make_text_run(after, run_attrs))
    return result, count


def is_plain_text_run(elem: ET.Element) -> bool:
    return (
        elem.tag == qname(HP_NS, "run")
        and len(elem) == 1
        and elem[0].tag == qname(HP_NS, "t")
    )


@dataclass(frozen=True)
class TextRunSpan:
    run: ET.Element
    text: str
    start: int
    end: int


def build_text_run_spans(runs: list[ET.Element]) -> list[TextRunSpan]:
    spans: list[TextRunSpan] = []
    pos = 0
    for run in runs:
        text = run[0].text or ""
        start = pos
        end = start + len(text)
        spans.append(TextRunSpan(run=run, text=text, start=start, end=end))
        pos = end
    return spans


def attrs_at_position(spans: list[TextRunSpan], pos: int) -> dict[str, str]:
    for span in spans:
        if span.start <= pos < span.end:
            return dict(span.run.attrib)
        if pos == span.start:
            return dict(span.run.attrib)
    if spans:
        return dict(spans[-1].run.attrib)
    return {}


def text_slice_to_runs(
    spans: list[TextRunSpan],
    start: int,
    end: int,
) -> list[ET.Element]:
    result: list[ET.Element] = []
    if start >= end:
        return result

    for span in spans:
        overlap_start = max(start, span.start)
        overlap_end = min(end, span.end)
        if overlap_start >= overlap_end:
            continue
        local_start = overlap_start - span.start
        local_end = overlap_end - span.start
        text = span.text[local_start:local_end]
        if text:
            result.append(make_text_run(text, dict(span.run.attrib)))
    return result


def replace_placeholders_in_run_group(
    runs: list[ET.Element],
    id_gen: IdGenerator,
    style: EquationStyle,
    context: ReplacementContext,
) -> tuple[list[ET.Element], int]:
    spans = build_text_run_spans(runs)
    text = "".join(span.text for span in spans)
    if "{{EQ" not in text:
        return runs, 0

    result: list[ET.Element] = []
    count = 0
    cursor = 0
    for placeholder in find_equation_placeholders(text):
        result.extend(text_slice_to_runs(spans, cursor, placeholder.start))
        run_attrs = attrs_at_position(spans, placeholder.start)
        script = placeholder_to_script(placeholder.kind, placeholder.body)
        result.append(make_equation_run(script, id_gen.next(), run_attrs, style=style))
        if is_numbered_placeholder(placeholder.kind):
            number = context.next_equation_number
            context.next_equation_number += 1
            result.append(make_text_run(f" ({number})", run_attrs))
        count += 1
        cursor = placeholder.end

    result.extend(text_slice_to_runs(spans, cursor, len(text)))
    return result, count


def replace_placeholders_in_run_group_lenient(
    runs: list[ET.Element],
    id_gen: IdGenerator,
    style: EquationStyle,
    context: ReplacementContext,
) -> tuple[list[ET.Element], int]:
    """Convert valid placeholders and leave malformed markers as plain text."""
    spans = build_text_run_spans(runs)
    text = "".join(span.text for span in spans)
    result: list[ET.Element] = []
    count = 0
    cursor = 0

    for placeholder in find_equation_placeholders(text, strict=False):
        result.extend(text_slice_to_runs(spans, cursor, placeholder.start))
        run_attrs = attrs_at_position(spans, placeholder.start)
        script = placeholder_to_script(placeholder.kind, placeholder.body)
        result.append(make_equation_run(script, id_gen.next(), run_attrs, style=style))
        if is_numbered_placeholder(placeholder.kind):
            number = context.next_equation_number
            context.next_equation_number += 1
            result.append(make_text_run(f" ({number})", run_attrs))
        count += 1
        cursor = placeholder.end

    if cursor < len(text):
        tail_text = strip_equation_markers_for_text(text[cursor:])
        if tail_text:
            result.append(make_text_run(tail_text, attrs_at_position(spans, cursor)))

    if not result:
        run_attrs = dict(runs[0].attrib) if runs else {}
        result.append(make_text_run(strip_equation_markers_for_text(text), run_attrs))
    return result, count


def replace_placeholders_in_section(
    xml_bytes: bytes,
    style: EquationStyle = EquationStyle(),
    context: ReplacementContext | None = None,
) -> tuple[bytes, int]:
    register_namespaces_from_xml(xml_bytes)
    root = ET.fromstring(xml_bytes)
    id_gen = IdGenerator(root)
    context = context or ReplacementContext()
    converted = 0
    did_change = False

    for para in root.findall(f".//{{{HP_NS}}}p"):
        replacements: list[tuple[int, int, list[ET.Element], int]] = []
        children = list(para)
        index = 0
        while index < len(children):
            if not is_plain_text_run(children[index]):
                index += 1
                continue

            start = index
            group: list[ET.Element] = []
            while index < len(children) and is_plain_text_run(children[index]):
                group.append(children[index])
                index += 1

            group_text = "".join(run[0].text or "" for run in group)
            if "{{EQ" not in group_text:
                continue

            try:
                new_runs, count = replace_placeholders_in_run_group(
                    group,
                    id_gen=id_gen,
                    style=style,
                    context=context,
                )
            except Exception as exc:
                new_runs, count = replace_placeholders_in_run_group_lenient(
                    group,
                    id_gen=id_gen,
                    style=style,
                    context=context,
                )
                print(
                    "[hwpx-equation] malformed equation marker left as text: "
                    f"{exc}",
                    file=sys.stderr,
                )
                replacements.append((start, index, new_runs, count))
                continue
            if count:
                replacements.append((start, index, new_runs, count))

        for start, end, new_runs, count in reversed(replacements):
            for old_run in children[start:end]:
                para.remove(old_run)
            for offset, run in enumerate(new_runs):
                para.insert(start + offset, run)
            converted += count
            did_change = True

    if not did_change:
        return xml_bytes, 0
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), converted


def find_section_files(zip_file: zipfile.ZipFile) -> list[str]:
    return sorted(
        name
        for name in zip_file.namelist()
        if name.startswith("Contents/section") and name.endswith(".xml")
    )


def write_zip_with_updates(
    input_hwpx: Path,
    output_hwpx: Path,
    updates: dict[str, bytes],
) -> None:
    output_hwpx.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(input_hwpx, "r") as zin, zipfile.ZipFile(output_hwpx, "w") as zout:
        names = zin.namelist()
        if "mimetype" in names:
            info = zin.getinfo("mimetype")
            out_info = copy.copy(info)
            out_info.compress_type = zipfile.ZIP_STORED
            zout.writestr(out_info, updates.get("mimetype", zin.read("mimetype")))

        for name in names:
            if name == "mimetype":
                continue
            info = zin.getinfo(name)
            out_info = copy.copy(info)
            data = updates.get(name, zin.read(name))
            zout.writestr(out_info, data)


def replace_equation_placeholders(
    input_hwpx: Path,
    output_hwpx: Path,
    style: EquationStyle = EquationStyle(),
    section: str | None = None,
    equation_number_start: int = 1,
) -> int:
    context = ReplacementContext(next_equation_number=equation_number_start)
    with zipfile.ZipFile(input_hwpx, "r") as zf:
        sections = [section] if section else find_section_files(zf)
        if not sections:
            raise FileNotFoundError("No Contents/section*.xml files found in HWPX.")

        updates: dict[str, bytes] = {}
        total = 0
        for section_name in sections:
            xml_bytes = zf.read(section_name)
            new_xml, count = replace_placeholders_in_section(
                xml_bytes,
                style=style,
                context=context,
            )
            if new_xml != xml_bytes:
                updates[section_name] = new_xml
            total += count

    write_zip_with_updates(input_hwpx, output_hwpx, updates)
    return total


def append_equation_paragraph_to_section(
    xml_bytes: bytes,
    script: str,
    style: EquationStyle = EquationStyle(),
    char_pr_id: str = "0",
    para_pr_id: str = "0",
    style_id: str = "0",
) -> bytes:
    register_namespaces_from_xml(xml_bytes)
    root = ET.fromstring(xml_bytes)
    id_gen = IdGenerator(root)

    para = ET.Element(
        qname(HP_NS, "p"),
        {
            "id": id_gen.next(),
            "paraPrIDRef": para_pr_id,
            "styleIDRef": style_id,
            "pageBreak": "0",
            "columnBreak": "0",
            "merged": "0",
        },
    )
    run_attrs = {"charPrIDRef": char_pr_id}
    para.append(make_equation_run(script, id_gen.next(), run_attrs, style=style))
    root.append(para)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def append_equation(
    input_hwpx: Path,
    output_hwpx: Path,
    script: str,
    style: EquationStyle = EquationStyle(),
    section: str = "Contents/section0.xml",
    char_pr_id: str = "0",
    para_pr_id: str = "0",
    style_id: str = "0",
) -> None:
    with zipfile.ZipFile(input_hwpx, "r") as zf:
        xml_bytes = zf.read(section)
        new_xml = append_equation_paragraph_to_section(
            xml_bytes,
            script,
            style=style,
            char_pr_id=char_pr_id,
            para_pr_id=para_pr_id,
            style_id=style_id,
        )
    write_zip_with_updates(input_hwpx, output_hwpx, {section: new_xml})


def build_style(args: argparse.Namespace) -> EquationStyle:
    return EquationStyle(
        base_unit=args.base_unit,
        text_color=args.color,
        line_thickness=args.line_thickness,
        letter_spacing=args.letter_spacing,
    )


def iter_scripts(xml_bytes: bytes) -> Iterable[str]:
    register_namespaces_from_xml(xml_bytes)
    root = ET.fromstring(xml_bytes)
    for script in root.findall(f".//{{{HP_NS}}}script"):
        yield script.text or ""


def inspect_equations(input_hwpx: Path) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    with zipfile.ZipFile(input_hwpx, "r") as zf:
        for section_name in find_section_files(zf):
            for script in iter_scripts(zf.read(section_name)):
                found.append((section_name, script))
    return found


def validate_hwpx_equations(input_hwpx: Path) -> list[str]:
    issues: list[str] = []
    try:
        with zipfile.ZipFile(input_hwpx, "r") as zf:
            sections = find_section_files(zf)
            if not sections:
                return ["No Contents/section*.xml files found in HWPX."]

            for section_name in sections:
                try:
                    xml_bytes = zf.read(section_name)
                    register_namespaces_from_xml(xml_bytes)
                    root = ET.fromstring(xml_bytes)
                except ET.ParseError as exc:
                    issues.append(f"{section_name}: XML parse error: {exc}")
                    continue

                for t in root.findall(f".//{{{HP_NS}}}t"):
                    if t.text and "{{EQ" in t.text:
                        issues.append(f"{section_name}: unresolved placeholder: {t.text}")

                for para in root.findall(f".//{{{HP_NS}}}p"):
                    children = list(para)
                    index = 0
                    while index < len(children):
                        if not is_plain_text_run(children[index]):
                            index += 1
                            continue
                        group: list[ET.Element] = []
                        while index < len(children) and is_plain_text_run(children[index]):
                            group.append(children[index])
                            index += 1
                        group_text = "".join(run[0].text or "" for run in group)
                        if "{{EQ" in group_text:
                            issues.append(
                                f"{section_name}: unresolved split placeholder: {group_text}"
                            )

                for script in root.findall(f".//{{{HP_NS}}}script"):
                    if not (script.text or "").strip():
                        issues.append(f"{section_name}: empty equation script")
    except zipfile.BadZipFile:
        return [f"{input_hwpx} is not a valid HWPX/ZIP file."]

    return issues


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Insert Hancom equation objects into HWPX files."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    replace_p = sub.add_parser(
        "replace", help="Replace {{EQ:...}} placeholders with hp:equation objects."
    )
    replace_p.add_argument("input_hwpx", type=Path)
    replace_p.add_argument("output_hwpx", type=Path)
    replace_p.add_argument("--section", help="Only edit one section XML path.")
    replace_p.add_argument("--base-unit", type=int, default=1000)
    replace_p.add_argument("--color", default="#000000")
    replace_p.add_argument("--line-thickness", type=int, default=100)
    replace_p.add_argument("--letter-spacing", type=int, default=0)
    replace_p.add_argument(
        "--number-start",
        type=int,
        default=1,
        help="First number used for {{EQN:...}} placeholders.",
    )

    append_p = sub.add_parser("append", help="Append one equation paragraph.")
    append_p.add_argument("input_hwpx", type=Path)
    append_p.add_argument("output_hwpx", type=Path)
    append_p.add_argument("--script", required=True, help="Hancom equation script.")
    append_p.add_argument("--latex", action="store_true", help="Treat --script as LaTeX.")
    append_p.add_argument("--section", default="Contents/section0.xml")
    append_p.add_argument("--char-pr-id", default="0")
    append_p.add_argument("--para-pr-id", default="0")
    append_p.add_argument("--style-id", default="0")
    append_p.add_argument("--base-unit", type=int, default=1000)
    append_p.add_argument("--color", default="#000000")
    append_p.add_argument("--line-thickness", type=int, default=100)
    append_p.add_argument("--letter-spacing", type=int, default=0)

    convert_p = sub.add_parser("convert-latex", help="Convert common LaTeX to HWP script.")
    convert_p.add_argument("latex")

    inspect_p = sub.add_parser("inspect", help="Print equation scripts in a HWPX file.")
    inspect_p.add_argument("input_hwpx", type=Path)

    validate_p = sub.add_parser(
        "validate", help="Check XML, unresolved placeholders, and empty scripts."
    )
    validate_p.add_argument("input_hwpx", type=Path)

    args = parser.parse_args(argv)

    if args.command == "replace":
        count = replace_equation_placeholders(
            args.input_hwpx,
            args.output_hwpx,
            style=build_style(args),
            section=args.section,
            equation_number_start=args.number_start,
        )
        print(f"Inserted {count} equation(s): {args.output_hwpx}")
        return 0

    if args.command == "append":
        script = LatexToHwpConverter().convert(args.script) if args.latex else args.script
        append_equation(
            args.input_hwpx,
            args.output_hwpx,
            script,
            style=build_style(args),
            section=args.section,
            char_pr_id=args.char_pr_id,
            para_pr_id=args.para_pr_id,
            style_id=args.style_id,
        )
        print(f"Appended equation: {args.output_hwpx}")
        return 0

    if args.command == "convert-latex":
        print(LatexToHwpConverter().convert(args.latex))
        return 0

    if args.command == "inspect":
        for section_name, script in inspect_equations(args.input_hwpx):
            print(f"{section_name}: {script}")
        return 0

    if args.command == "validate":
        issues = validate_hwpx_equations(args.input_hwpx)
        if not issues:
            print(f"OK: {args.input_hwpx}")
            return 0
        for issue in issues:
            print(f"ERROR: {issue}")
        return 1

    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main())
