# -*- coding: utf-8 -*-
"""
코딩 테스트 채점 하니스 (브라우저 Pyodide · 로컬 빌드 공용).

이 파일 하나가 "정답 판정 규칙"의 단일 출처다.
 - 브라우저: exam-prep.html 이 /api/coding/harness.py 로 받아 Pyodide 에 주입하고
   judge(student_src, problem_json) 를 호출한다.
 - 빌드:    scripts/build_coding_problems.py 가 compute_got() 로 기대출력을 굽고(bake),
   run_problem() 으로 모든 레퍼런스 풀이가 자기 테스트를 통과하는지 자가검증한다.

순수 표준 라이브러리만 쓴다. exec/eval 대상은 (1) 학생 코드 — 브라우저 Pyodide
샌드박스 안에서만 실행되고, (2) 우리가 직접 작성한 신뢰된 테스트 리터럴뿐이다.
"""
import json
import io
import os
import math
import contextlib
import builtins

SAFE_BUILTINS = builtins


def _to_plain(x):
    """학생이 list() 를 빼먹고 filter/map/zip/generator 를 그대로 반환하는 흔한 경우를 관용한다."""
    if type(x).__name__ in ("filter", "map", "zip", "generator", "range"):
        try:
            return list(x)
        except Exception:
            return x
    return x


def _float_eq(a, b, tol=1e-6):
    try:
        return abs(float(a) - float(b)) <= tol + tol * abs(float(b))
    except Exception:
        return a == b


def _float_deep(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return _float_eq(a, b)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(_float_deep(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_float_deep(a[k], b[k]) for k in a)
    return a == b


def _deep_eq(a, b, mode):
    """compare 모드별 정답 비교.
    value  : 파이썬 == (기본)
    set    : 순서 무관(다중집합) 비교
    groups : 그룹 분할 비교(그룹 순서·그룹 내 순서 모두 무관)
    float  : 부동소수 오차 허용(중첩 구조까지)
    """
    if mode == "set":
        try:
            return sorted(a) == sorted(b)
        except Exception:
            try:
                return set(a) == set(b)
            except Exception:
                return a == b
    if mode == "groups":
        try:
            norm = lambda L: sorted(tuple(sorted(g)) for g in L)
            return norm(a) == norm(b)
        except Exception:
            return a == b
    if mode == "float":
        return _float_deep(a, b)
    return a == b


def _short(value, limit=600):
    try:
        s = repr(value)
    except Exception:
        s = str(value)
    return s if len(s) <= limit else s[:limit] + " …(생략)"


def _write_files(files):
    written = []
    for name, content in (files or {}).items():
        with open(name, "w", encoding="utf-8") as f:
            f.write(content)
        written.append(name)
    return written


def _cleanup(names):
    for n in names or []:
        try:
            os.remove(n)
        except Exception:
            pass


def _eval_lit(src):
    return eval(src, {"__builtins__": SAFE_BUILTINS}, {})


def _exec_and_get(student_src, problem, test):
    """학생 코드를 실행하고 이 테스트의 실제 출력 객체(got)를 만들어 돌려준다(공용)."""
    mode = test.get("mode") or problem.get("mode") or "function"
    env = {"__builtins__": SAFE_BUILTINS, "__name__": "__student__"}
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(student_src, env)
        if mode == "snippet":
            exec(test["epilogue"], env)
            got = env.get("result")
        else:  # function · file
            fn = env.get(problem["entry"])
            if not callable(fn):
                raise NameError("함수 '%s' 를 정의하지 않았습니다." % problem["entry"])
            args = _eval_lit(test.get("args", "()"))
            got = fn(*args)
    return _to_plain(got), buf.getvalue()


def compute_got(student_src, problem, test):
    """빌드용: 레퍼런스 풀이로 기대출력 객체를 계산한다(파일 테스트는 파일을 쓰고 지운다)."""
    written = _write_files(test.get("files"))
    try:
        got, _stdout = _exec_and_get(student_src, problem, test)
        return got
    finally:
        _cleanup(written)


def run_one(student_src, problem, test):
    compare = test.get("compare") or problem.get("compare") or "value"
    out = {
        "name": test.get("name", ""),
        "hidden": bool(test.get("hidden")),
        "passed": False,
        "error": None,
        "stdout": "",
        "got": "",
        "expected": _short(_eval_lit(test["expected"])) if "expected" in test else "",
    }
    written = []
    try:
        expected = _eval_lit(test["expected"])
        written = _write_files(test.get("files"))
        got, stdout = _exec_and_get(student_src, problem, test)
        out["stdout"] = stdout
        out["got"] = _short(got)
        out["passed"] = bool(_deep_eq(got, expected, compare))
    except Exception as e:
        out["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        _cleanup(written)
    return out


def run_problem(student_src, problem):
    return [run_one(student_src, problem, t) for t in problem.get("tests", [])]


def judge(student_src, problem_json):
    """브라우저(Pyodide)에서 호출하는 진입점. 결과 배열을 JSON 문자열로 돌려준다."""
    problem = json.loads(problem_json)
    return json.dumps(run_problem(student_src, problem), ensure_ascii=False)
