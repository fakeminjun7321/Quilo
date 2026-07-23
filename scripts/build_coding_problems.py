# -*- coding: utf-8 -*-
"""
코딩 테스트 문제 빌드 스크립트.

각 문제의 (레퍼런스 풀이 + 테스트 입력)을 정의하면, 이 스크립트가
  1) 레퍼런스 풀이를 lib/coding/harness.py 로 실행해 기대출력(expected)을 굽고(bake),
  2) 같은 하니스로 레퍼런스가 자기 테스트를 모두 통과하는지 자가검증한 뒤,
  3) 레퍼런스 풀이는 제외하고 lib/coding/problems.json 으로 내보낸다.

→ 브라우저(Pyodide)가 받는 problems.json 에는 정답 코드가 들어가지 않는다.
   기대출력은 항상 '진짜 파이썬 실행 결과'라서 손으로 계산하다 틀릴 일이 없다.

실행:  .venv/bin/python3 scripts/build_coding_problems.py   (또는 python3)
"""
import os
import sys
import json
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib", "coding"))
import harness  # noqa: E402

OUT_PATH = os.path.join(ROOT, "lib", "coding", "problems.json")


# ── 문제 정의 ────────────────────────────────────────────────────────────────
# 각 문제: id/week/title/difficulty/tags/summary/statement_md/constraints_md
#          mode(function|snippet|file 기본 function) / entry / compare(기본 value)
#          starter / solution(빌드 전용) / tests[]
# 테스트: name/hidden + (function·file) args / (snippet) epilogue / (file) files

PROBLEMS = [
    # ─────────────────────────────── 1주차 ───────────────────────────────
    {
        "id": "w1-gugudan",
        "week": 1,
        "title": "가로로 출력하는 구구단",
        "difficulty": "쉬움",
        "tags": ["리스트 컴프리헨션", "join"],
        "summary": "2단부터 9단까지를 가로로 나란히 출력하는 문자열을 만든다.",
        "statement_md": (
            "2단부터 9단까지의 구구단을 **가로로 나란히** 늘어놓은 문자열을 반환하는 "
            "`gugudan()` 함수를 작성하세요.\n\n"
            "- 줄(행)은 곱하는 수 `i`가 1부터 9까지, 모두 **9줄**입니다.\n"
            "- 한 줄 안에서는 단 `d`가 2부터 9까지 왼쪽→오른쪽으로 늘어섭니다.\n"
            "- 한 칸의 형식은 `\"d x i = d*i\"` (사이에 공백), 칸 사이 구분자는 `\" | \"` 입니다.\n"
            "- 줄 사이는 줄바꿈 `\\n` 하나로 잇고, 맨 끝에는 줄바꿈을 붙이지 않습니다.\n\n"
            "즉 첫 줄은 `2 x 1 = 2 | 3 x 1 = 3 | … | 9 x 1 = 9`, "
            "둘째 줄은 `2 x 2 = 4 | 3 x 2 = 6 | … | 9 x 2 = 18` … 이런 식입니다."
        ),
        "constraints_md": (
            "- 이중 `for`문 + `print(end=\" \")` 방식 대신 **리스트 컴프리헨션**과 "
            "`\" | \".join(...)`, `\"\\n\".join(...)`을 활용하세요."
        ),
        "entry": "gugudan",
        "starter": "def gugudan():\n    # 여기에 작성하세요\n    return \"\"\n",
        "solution": (
            "def gugudan():\n"
            "    return \"\\n\".join(\n"
            "        \" | \".join(f\"{d} x {i} = {d*i}\" for d in range(2, 10))\n"
            "        for i in range(1, 10)\n"
            "    )\n"
        ),
        "tests": [
            {"name": "구구단 전체", "args": "()"},
        ],
    },
    {
        "id": "w1-transpose",
        "week": 1,
        "title": "행렬 전치(Transpose) 최적화",
        "difficulty": "쉬움",
        "tags": ["zip", "언패킹"],
        "summary": "2차원 리스트의 행과 열을 뒤바꾼다.",
        "statement_md": (
            "2차원 리스트(행렬) `matrix`가 주어질 때, 행과 열을 뒤바꾼(전치) 결과를 "
            "반환하는 `transpose(matrix)` 함수를 작성하세요.\n\n"
            "- 입력 예시: `[[1, 2, 3], [4, 5, 6]]`\n"
            "- 출력 예시: `[[1, 4], [2, 5], [3, 6]]`"
        ),
        "constraints_md": (
            "- 가급적 **한 줄**로 구현해 보세요. `zip` 과 리스트 언패킹 `*` 을 활용합니다.\n"
            "- 각 행은 `list` 형태로 반환하세요(튜플 X)."
        ),
        "entry": "transpose",
        "starter": "def transpose(matrix):\n    # 여기에 작성하세요\n    pass\n",
        "solution": "def transpose(matrix):\n    return [list(row) for row in zip(*matrix)]\n",
        "tests": [
            {"name": "2x3", "args": "([[1, 2, 3], [4, 5, 6]],)"},
            {"name": "3x2", "hidden": True, "args": "([[1, 2], [3, 4], [5, 6]],)"},
            {"name": "1x1", "hidden": True, "args": "([[7]],)"},
            {"name": "3x4", "hidden": True, "args": "([[1,2,3,4],[5,6,7,8],[9,10,11,12]],)"},
        ],
    },
    {
        "id": "w1-anagram-filter",
        "week": 1,
        "title": "애너그램(Anagram) 필터링",
        "difficulty": "쉬움",
        "tags": ["filter", "lambda"],
        "summary": "기준 단어와 애너그램 관계인 단어만 추출한다.",
        "statement_md": (
            "문자열 리스트 `word_list` 와 기준 단어 `target` 이 주어집니다. 리스트에서 "
            "`target` 과 **구성(철자의 개수)이 같은** 단어들만 입력 순서대로 추출하는 "
            "`filter_anagrams(word_list, target)` 함수를 작성하세요.\n\n"
            "- 입력: `word_list = [\"listen\",\"silent\",\"enlist\",\"hello\",\"tinsel\"]`, "
            "`target = \"inlets\"`\n"
            "- 출력: `['listen', 'silent', 'enlist', 'tinsel']`"
        ),
        "constraints_md": (
            "- `filter()` 함수와 `lambda` 표현식을 사용하세요(`for` 루프 없이).\n"
            "- 결과는 `list` 로 반환합니다. 대소문자는 구분합니다."
        ),
        "entry": "filter_anagrams",
        "starter": "def filter_anagrams(word_list, target):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def filter_anagrams(word_list, target):\n"
            "    return list(filter(lambda w: sorted(w) == sorted(target), word_list))\n"
        ),
        "tests": [
            {"name": "inlets", "args": "(['listen','silent','enlist','hello','tinsel'], 'inlets')"},
            {"name": "abc", "hidden": True, "args": "(['cab','bca','xyz','ab','abc','aabbcc'], 'abc')"},
            {"name": "aabb", "hidden": True, "args": "(['abab','baba','abc','aabb','ab'], 'aabb')"},
            {"name": "대소문자", "hidden": True, "args": "(['rat','tar','car','art','ART'], 'art')"},
        ],
    },
    {
        "id": "w1-local-maxima",
        "week": 1,
        "title": "병렬 리스트의 국소 최댓값",
        "difficulty": "쉬움",
        "tags": ["zip", "map"],
        "summary": "같은 인덱스 값들 중 최댓값을 모은 리스트를 만든다.",
        "statement_md": (
            "동일한 길이의 세 리스트 `L1, L2, L3` 가 주어집니다. 같은 인덱스에 위치한 "
            "값들 중 가장 큰 값만 모아 새로운 리스트를 만드는 "
            "`get_local_maxima(L1, L2, L3)` 함수를 작성하세요.\n\n"
            "- 입력: `L1=[1,5,9]`, `L2=[2,4,8]`, `L3=[3,6,7]`\n"
            "- 출력: `[3, 6, 9]`"
        ),
        "constraints_md": (
            "- 인덱스 `i` 를 직접 쓰지 말고, `zip()` 과 `map()` 을 조합해 선언적으로 작성하세요.\n"
            "- 결과는 `list` 로 반환합니다."
        ),
        "entry": "get_local_maxima",
        "starter": "def get_local_maxima(L1, L2, L3):\n    # 여기에 작성하세요\n    pass\n",
        "solution": "def get_local_maxima(L1, L2, L3):\n    return list(map(max, L1, L2, L3))\n",
        "tests": [
            {"name": "기본", "args": "([1,5,9], [2,4,8], [3,6,7])"},
            {"name": "혼합", "hidden": True, "args": "([10,20,30], [5,25,15], [12,1,40])"},
            {"name": "단일", "hidden": True, "args": "([0], [0], [0])"},
            {"name": "음수", "hidden": True, "args": "([-1,-5], [-2,-3], [-9,-4])"},
        ],
    },
    {
        "id": "w1-sieve",
        "week": 1,
        "title": "에라토스테네스의 체 (집합)",
        "difficulty": "보통",
        "tags": ["set", "차집합"],
        "summary": "집합 연산으로 n 이하의 소수를 구한다.",
        "statement_md": (
            "소수를 찾는 고전 알고리즘 '에라토스테네스의 체'를 구현하는 "
            "`sieve_of_eratosthenes(n)` 함수를 작성하세요. n 이하의 모든 소수를 "
            "**오름차순 리스트**로 반환합니다.\n\n"
            "- 입력: `n = 30`\n"
            "- 출력: `[2, 3, 5, 7, 11, 13, 17, 19, 23, 29]`"
        ),
        "constraints_md": (
            "- 배열에 True/False 를 기록하는 방식이 아니라 **집합론**으로 풀어 보세요.\n"
            "- 초기 전체 집합 `set(range(2, n+1))` 을 만들고, 소수의 배수들을 "
            "집합의 **차집합 연산(`-`)** 으로 제거해 나갑니다."
        ),
        "entry": "sieve_of_eratosthenes",
        "starter": "def sieve_of_eratosthenes(n):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def sieve_of_eratosthenes(n):\n"
            "    sieve = set(range(2, n + 1))\n"
            "    for i in range(2, int(n ** 0.5) + 1):\n"
            "        if i in sieve:\n"
            "            sieve -= set(range(i * i, n + 1, i))\n"
            "    return sorted(sieve)\n"
        ),
        "tests": [
            {"name": "n=30", "args": "(30,)"},
            {"name": "n=2", "hidden": True, "args": "(2,)"},
            {"name": "n=10", "hidden": True, "args": "(10,)"},
            {"name": "n=1", "hidden": True, "args": "(1,)"},
            {"name": "n=50", "hidden": True, "args": "(50,)"},
        ],
    },
    {
        "id": "w1-dna",
        "week": 1,
        "title": "DNA 염기서열 기초 분석",
        "difficulty": "보통",
        "tags": ["딕셔너리 컴프리헨션", "str.translate"],
        "summary": "염기 빈도수 딕셔너리와 상보적 가닥을 함께 만든다.",
        "statement_md": (
            "A, T, G, C 로 이루어진 DNA 시퀀스 문자열이 주어집니다. 두 가지를 수행하는 "
            "`analyze_dna(dna_sequence)` 함수를 작성하세요.\n\n"
            "1. **빈도수**: A, T, G, C 각각의 개수를 담은 딕셔너리(키 순서 `A, T, G, C`).\n"
            "2. **상보적 가닥**: A↔T, G↔C 로 치환한 문자열.\n\n"
            "`(빈도수_딕셔너리, 상보적_가닥_문자열)` 형태의 **튜플**을 반환합니다.\n\n"
            "- 입력: `\"ATGCGTA\"`\n"
            "- 출력: `({'A': 2, 'T': 2, 'G': 2, 'C': 1}, 'TACGCAT')`"
        ),
        "constraints_md": (
            "- 빈도수는 딕셔너리 컴프리헨션으로, 상보 가닥은 `str.maketrans` + "
            "`translate` 로 한 번에 치환하세요(반복문으로 문자열을 이어 붙이지 마세요)."
        ),
        "entry": "analyze_dna",
        "starter": "def analyze_dna(dna_sequence):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def analyze_dna(dna_sequence):\n"
            "    freq = {b: dna_sequence.count(b) for b in 'ATGC'}\n"
            "    table = str.maketrans('ATGC', 'TACG')\n"
            "    return freq, dna_sequence.translate(table)\n"
        ),
        "tests": [
            {"name": "ATGCGTA", "args": "('ATGCGTA',)"},
            {"name": "AAAA", "hidden": True, "args": "('AAAA',)"},
            {"name": "ATGC", "hidden": True, "args": "('ATGC',)"},
            {"name": "혼합", "hidden": True, "args": "('GGGCCCAAATTT',)"},
        ],
    },
    # ─────────────────────────────── 2주차 ───────────────────────────────
    {
        "id": "w2-still-inside",
        "week": 2,
        "title": "대규모 출입 로그 분석",
        "difficulty": "쉬움",
        "tags": ["set", "차집합"],
        "summary": "들어왔지만 나가지 않은 사람의 ID를 추출한다.",
        "statement_md": (
            "출입 로그 리스트 `entered`(입장)와 `left`(퇴장)가 주어집니다. 들어왔지만 "
            "아직 나가지 않은(내부 체류 중인) 사람들의 ID 리스트를 반환하는 "
            "`still_inside(entered, left)` 함수를 작성하세요.\n\n"
            "- 입력: `entered=[101,102,103,104,105]`, `left=[102,104]`\n"
            "- 출력: `[101, 103, 105]` (순서 무관)"
        ),
        "constraints_md": (
            "- `for` 루프 순차 탐색 금지. **집합(Set)의 차집합 연산**으로 한 줄에 푸세요.\n"
            "- 채점은 순서를 따지지 않습니다(집합 비교)."
        ),
        "entry": "still_inside",
        "compare": "set",
        "starter": "def still_inside(entered, left):\n    # 여기에 작성하세요\n    pass\n",
        "solution": "def still_inside(entered, left):\n    return list(set(entered) - set(left))\n",
        "tests": [
            {"name": "기본", "args": "([101,102,103,104,105], [102,104])"},
            {"name": "퇴장없음", "hidden": True, "args": "([1,2,3], [])"},
            {"name": "중복입장", "hidden": True, "args": "([5,5,6,7], [6])"},
            {"name": "전원퇴장", "hidden": True, "args": "([1,2,3], [1,2,3])"},
        ],
    },
    {
        "id": "w2-first-duplicate",
        "week": 2,
        "title": "첫 번째 반복 요소 찾기",
        "difficulty": "쉬움",
        "tags": ["set", "O(n)"],
        "summary": "왼쪽부터 읽으며 처음으로 중복되는 값을 찾는다.",
        "statement_md": (
            "정수 배열이 주어질 때, 왼쪽부터 읽으면서 **가장 처음으로 두 번째 등장하는** "
            "숫자를 반환하는 `first_duplicate(arr)` 함수를 작성하세요. 중복이 없으면 "
            "`-1` 을 반환합니다.\n\n"
            "- 입력: `[2, 5, 1, 2, 3, 5, 1, 2, 4]`\n"
            "- 출력: `2` (5보다 2가 먼저 두 번째로 등장)"
        ),
        "constraints_md": (
            "- 이중 루프 금지. 빈 `set()` 에 본 값을 기록하며 시간 복잡도 **O(n)** 으로 푸세요."
        ),
        "entry": "first_duplicate",
        "starter": "def first_duplicate(arr):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def first_duplicate(arr):\n"
            "    seen = set()\n"
            "    for x in arr:\n"
            "        if x in seen:\n"
            "            return x\n"
            "        seen.add(x)\n"
            "    return -1\n"
        ),
        "tests": [
            {"name": "기본", "args": "([2,5,1,2,3,5,1,2,4],)"},
            {"name": "중복없음", "hidden": True, "args": "([1,2,3,4],)"},
            {"name": "즉시중복", "hidden": True, "args": "([7,7],)"},
            {"name": "긴배열", "hidden": True, "args": "([3,1,4,1,5,9,2,6],)"},
            {"name": "빈배열", "hidden": True, "args": "([],)"},
        ],
    },
    {
        "id": "w2-longest-substring",
        "week": 2,
        "title": "중복 없는 가장 긴 부분문자열",
        "difficulty": "어려움",
        "tags": ["슬라이딩 윈도우", "dict"],
        "summary": "같은 문자가 한 번도 중복되지 않는 가장 긴 연속 부분문자열의 길이.",
        "statement_md": (
            "주어진 문자열에서 같은 문자가 단 한 번도 중복되지 않는 가장 긴 연속 부분 "
            "문자열의 **길이**를 구하는 `longest_unique_substring(s)` 함수를 작성하세요.\n\n"
            "- 입력 `\"abcabcbb\"` → 출력 `3` (\"abc\")\n"
            "- 입력 `\"pwwkew\"` → 출력 `3` (\"wke\")"
        ),
        "constraints_md": (
            "- `dict` 로 각 문자의 최신 인덱스를 기억하고, 중복을 만나면 슬라이딩 윈도우의 "
            "시작점을 점프시키는 방식으로 **O(n)** 에 푸세요."
        ),
        "entry": "longest_unique_substring",
        "starter": "def longest_unique_substring(s):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def longest_unique_substring(s):\n"
            "    last = {}\n"
            "    start = 0\n"
            "    best = 0\n"
            "    for i, ch in enumerate(s):\n"
            "        if ch in last and last[ch] >= start:\n"
            "            start = last[ch] + 1\n"
            "        last[ch] = i\n"
            "        best = max(best, i - start + 1)\n"
            "    return best\n"
        ),
        "tests": [
            {"name": "abcabcbb", "args": "('abcabcbb',)"},
            {"name": "pwwkew", "args": "('pwwkew',)"},
            {"name": "bbbbb", "hidden": True, "args": "('bbbbb',)"},
            {"name": "빈문자열", "hidden": True, "args": "('',)"},
            {"name": "모두다름", "hidden": True, "args": "('abcdef',)"},
            {"name": "dvdf", "hidden": True, "args": "('dvdf',)"},
        ],
    },
    {
        "id": "w2-group-anagrams",
        "week": 2,
        "title": "애너그램 그룹핑",
        "difficulty": "보통",
        "tags": ["defaultdict", "tuple key"],
        "summary": "애너그램끼리 리스트로 묶는다.",
        "statement_md": (
            "영단어 리스트가 주어지면, 사용된 알파벳의 종류와 개수가 완벽히 동일한 "
            "단어(애너그램)들끼리 리스트로 묶어 반환하는 `group_anagrams(words)` 함수를 "
            "작성하세요.\n\n"
            "- 입력: `[\"eat\",\"tea\",\"tan\",\"ate\",\"nat\",\"bat\"]`\n"
            "- 출력: `[['eat','tea','ate'], ['tan','nat'], ['bat']]` (그룹 순서 무관)"
        ),
        "constraints_md": (
            "- `collections.defaultdict(list)` 를 사용하세요. 단어를 `sorted()` 후 "
            "`tuple` 로 변환하여 딕셔너리 키로 씁니다(리스트는 키가 될 수 없음).\n"
            "- 채점은 그룹 순서·그룹 내 순서를 따지지 않습니다."
        ),
        "entry": "group_anagrams",
        "compare": "groups",
        "starter": "def group_anagrams(words):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "from collections import defaultdict\n"
            "def group_anagrams(words):\n"
            "    groups = defaultdict(list)\n"
            "    for w in words:\n"
            "        groups[tuple(sorted(w))].append(w)\n"
            "    return list(groups.values())\n"
        ),
        "tests": [
            {"name": "기본", "args": "(['eat','tea','tan','ate','nat','bat'],)"},
            {"name": "중복단어", "hidden": True, "args": "(['a','b','a'],)"},
            {"name": "3글자", "hidden": True, "args": "(['abc','cba','bca','xy'],)"},
            {"name": "빈입력", "hidden": True, "args": "([],)"},
        ],
    },
    {
        "id": "w2-caesar",
        "week": 2,
        "title": "시저 암호 빈도 분석 해독",
        "difficulty": "어려움",
        "tags": ["Counter", "암호학"],
        "summary": "빈도 분석으로 시저 암호 평문 후보 3개를 만든다.",
        "statement_md": (
            "평문 없이 '암호문'만 주어졌습니다. 영어에서 알파벳 빈도가 높은 순서가 "
            "`E, T, A` 라는 가정을 이용해 평문 후보 3개를 만드는 "
            "`caesar_decrypt_candidates(cipher)` 함수를 작성하세요. 다음 규칙을 **정확히** 따르세요.\n\n"
            "1. 암호문에서 알파벳만 모아 대문자로 통일해 빈도를 셉니다(`collections.Counter`).\n"
            "2. **빈도 내림차순**, 동률이면 **알파벳 오름차순**으로 상위 3개 암호 문자를 고릅니다.\n"
            "3. 그 3개가 각각 평문 `E`, `T`, `A` 였다고 가정합니다. 각 가정의 시프트는 "
            "`shift = (ord(암호문자) - ord(평문문자)) % 26` 입니다.\n"
            "4. 각 시프트로 **대소문자를 유지**하며 알파벳을 거꾸로 밀어 복호화하고, "
            "공백·기호는 그대로 둡니다.\n"
            "5. `(shift, 복호화된_평문)` 튜플 3개를 **빈도 상위 순서대로** 리스트로 반환합니다.\n\n"
            "- 입력: `\"KHOOR ZRUOG. WKLV LV D WHVW.\"` (\"HELLO WORLD. THIS IS A TEST.\" 를 3칸 민 암호)\n"
            "- 후보 중 하나는 `(3, 'HELLO WORLD. THIS IS A TEST.')` 가 됩니다."
        ),
        "constraints_md": (
            "- 동률 처리(알파벳 오름차순)와 시프트 공식을 위 설명 그대로 구현해야 "
            "기대 출력과 일치합니다."
        ),
        "entry": "caesar_decrypt_candidates",
        "starter": "def caesar_decrypt_candidates(cipher):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "from collections import Counter\n"
            "def caesar_decrypt_candidates(cipher):\n"
            "    counts = Counter(c.upper() for c in cipher if c.isalpha())\n"
            "    top = [ch for ch, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]]\n"
            "    out = []\n"
            "    upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'\n"
            "    lower = 'abcdefghijklmnopqrstuvwxyz'\n"
            "    for assume, plain in zip(top, 'ETA'):\n"
            "        shift = (ord(assume) - ord(plain)) % 26\n"
            "        dec_u = ''.join(chr((ord(c) - 65 - shift) % 26 + 65) for c in upper)\n"
            "        dec_l = ''.join(chr((ord(c) - 97 - shift) % 26 + 97) for c in lower)\n"
            "        table = str.maketrans(upper + lower, dec_u + dec_l)\n"
            "        out.append((shift, cipher.translate(table)))\n"
            "    return out\n"
        ),
        "tests": [
            {"name": "HELLO WORLD", "args": "('KHOOR ZRUOG. WKLV LV D WHVW.',)"},
            {"name": "다른 문장", "hidden": True, "args": "('WKH TXLFN EURZQ IRA.',)"},
        ],
    },
    {
        "id": "w2-motif",
        "week": 2,
        "title": "모티프(Motif) 탐색",
        "difficulty": "보통",
        "tags": ["슬라이싱", "리스트 컴프리헨션"],
        "summary": "DNA에서 모티프가 등장하는 모든 시작 인덱스를 찾는다.",
        "statement_md": (
            "긴 DNA 염기서열 `dna` 와 짧은 패턴 `motif` 가 주어집니다. `dna` 안에서 "
            "`motif` 가 등장하는 모든 시작 인덱스(0-based)를 리스트로 반환하는 "
            "`find_motif(dna, motif)` 함수를 작성하세요. **겹쳐서 등장하는 경우도 모두** "
            "찾아야 합니다.\n\n"
            "- 입력: `dna=\"GATATATGCATATACTT\"`, `motif=\"ATAT\"`\n"
            "- 출력: `[1, 3, 9]`"
        ),
        "constraints_md": (
            "- 문자 단위 이중 비교 대신, 슬라이싱 `dna[i:i+len(motif)]` 과 "
            "리스트 컴프리헨션을 결합해 한 줄로 작성하세요."
        ),
        "entry": "find_motif",
        "starter": "def find_motif(dna, motif):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def find_motif(dna, motif):\n"
            "    n = len(motif)\n"
            "    return [i for i in range(len(dna) - n + 1) if dna[i:i+n] == motif]\n"
        ),
        "tests": [
            {"name": "기본", "args": "('GATATATGCATATACTT', 'ATAT')"},
            {"name": "AAAA", "hidden": True, "args": "('AAAA', 'AA')"},
            {"name": "ABCABC", "hidden": True, "args": "('ABCABC', 'ABC')"},
            {"name": "없음", "hidden": True, "args": "('XYZ', 'A')"},
            {"name": "겹침", "hidden": True, "args": "('ATATAT', 'ATAT')"},
        ],
    },
    # ─────────────────────────────── 3주차 ───────────────────────────────
    {
        "id": "w3-find-404",
        "week": 3,
        "title": "특정 에러 로그만 추출",
        "difficulty": "쉬움",
        "tags": ["파일 입력", "generator"],
        "summary": "큰 로그 파일에서 ERROR 404 줄만 골라낸다.",
        "statement_md": (
            "용량이 큰 서버 로그 파일 `filepath` 가 주어집니다. 파일을 한 줄씩 읽으며 "
            "`\"ERROR 404\"` 가 포함된 줄(line)만 골라 **리스트**로 반환하는 "
            "`find_404(filepath)` 함수를 작성하세요. 각 줄 끝의 줄바꿈은 제거합니다.\n\n"
            "입력 파일 `server.log` 예시:\n```\nINFO: User logged in\n"
            "ERROR 404: Page not found /home\nWARNING: High CPU usage\n"
            "ERROR 404: Image missing /logo.png\n```\n"
            "출력: `['ERROR 404: Page not found /home', 'ERROR 404: Image missing /logo.png']`"
        ),
        "constraints_md": (
            "- 파일을 통째로 `read()`/`readlines()` 하지 말고, `with open(...)` 후 "
            "`for line in f:` 로 한 줄씩 처리하세요(메모리 절약)."
        ),
        "entry": "find_404",
        "starter": "def find_404(filepath):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def find_404(filepath):\n"
            "    out = []\n"
            "    with open(filepath, encoding='utf-8') as f:\n"
            "        for line in f:\n"
            "            if 'ERROR 404' in line:\n"
            "                out.append(line.rstrip('\\n'))\n"
            "    return out\n"
        ),
        "tests": [
            {
                "name": "기본",
                "args": "('server.log',)",
                "files": {"server.log": "INFO: User logged in\nERROR 404: Page not found /home\nWARNING: High CPU usage\nERROR 404: Image missing /logo.png\n"},
            },
            {
                "name": "404 없음",
                "hidden": True,
                "args": "('server.log',)",
                "files": {"server.log": "INFO: ok\nERROR 500: boom\n"},
            },
        ],
    },
    {
        "id": "w3-chunk-lines",
        "week": 3,
        "title": "대용량 파일 N줄씩 분할",
        "difficulty": "보통",
        "tags": ["파일 입력", "청크"],
        "summary": "파일을 N줄 단위 묶음 리스트로 나눈다.",
        "statement_md": (
            "큰 텍스트 파일 `filepath` 를 한 줄씩 읽어, `n` 줄씩 묶은 묶음들의 리스트를 "
            "반환하는 `chunk_lines(filepath, n)` 함수를 작성하세요. 마지막 묶음은 "
            "`n` 줄보다 적을 수 있습니다. 각 줄 끝 줄바꿈은 제거합니다.\n\n"
            "입력 파일 `big_data.txt` 가 `L1`~`L7` 7줄이고 `n=3` 이면\n"
            "출력: `[['L1','L2','L3'], ['L4','L5','L6'], ['L7']]`"
        ),
        "constraints_md": (
            "- 파일을 통째로 읽지 말고 한 줄씩 읽으며 `n` 줄이 모이면 묶음을 확정하세요."
        ),
        "entry": "chunk_lines",
        "starter": "def chunk_lines(filepath, n):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def chunk_lines(filepath, n):\n"
            "    chunks, cur = [], []\n"
            "    with open(filepath, encoding='utf-8') as f:\n"
            "        for line in f:\n"
            "            cur.append(line.rstrip('\\n'))\n"
            "            if len(cur) == n:\n"
            "                chunks.append(cur)\n"
            "                cur = []\n"
            "    if cur:\n"
            "        chunks.append(cur)\n"
            "    return chunks\n"
        ),
        "tests": [
            {
                "name": "7줄/3",
                "args": "('big_data.txt', 3)",
                "files": {"big_data.txt": "L1\nL2\nL3\nL4\nL5\nL6\nL7\n"},
            },
            {
                "name": "4줄/2",
                "hidden": True,
                "args": "('big_data.txt', 2)",
                "files": {"big_data.txt": "a\nb\nc\nd\n"},
            },
            {
                "name": "3줄/10",
                "hidden": True,
                "args": "('big_data.txt', 10)",
                "files": {"big_data.txt": "x\ny\nz\n"},
            },
        ],
    },
    {
        "id": "w3-routers-csv",
        "week": 3,
        "title": "복합 조건 CSV 데이터 전처리",
        "difficulty": "어려움",
        "tags": ["CSV", "단위 변환", "정렬"],
        "summary": "메모리를 KiB로 환산하고 가격순 정렬해 포맷한다.",
        "statement_md": (
            "와이파이 라우터 판매 데이터 `routers.csv` 를 읽어 전처리합니다. "
            "헤더는 `name,type,memory,price` 이고, `process_routers(filepath)` 함수가 "
            "다음을 수행해 **문자열 리스트**를 반환하게 하세요.\n\n"
            "1. `memory` 의 단위(`GB`/`MB`/`kB`)를 표준 단위 **KiB** 숫자로 변환합니다. "
            "(1GB = 1024MB, 1MB = 1024kB)\n"
            "2. `price` 기준 **오름차순** 정렬합니다.\n"
            "3. 각 행을 `f\"[{type}] {name} - {kib}KiB / ${price}\"` 형식의 문자열로 만듭니다.\n\n"
            "예) `[Wi-Fi 6] Netgear Nighthawk - 1048576.0KiB / $199.99`\n\n"
            "`kib` 와 `price` 는 파이썬 `float` 그대로 문자열에 넣습니다(예: 1024kB → `1024.0`)."
        ),
        "constraints_md": (
            "- `pandas`/`csv` 모듈의 고급 기능을 쓰지 말고, 내장 함수와 기본 자료구조만 "
            "사용하세요(`split(',')` 등)."
        ),
        "entry": "process_routers",
        "starter": "def process_routers(filepath):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def process_routers(filepath):\n"
            "    with open(filepath, encoding='utf-8') as f:\n"
            "        lines = [ln.strip() for ln in f if ln.strip()]\n"
            "    header = lines[0].split(',')\n"
            "    rows = []\n"
            "    for ln in lines[1:]:\n"
            "        rec = dict(zip(header, ln.split(',')))\n"
            "        mem = rec['memory']\n"
            "        if mem.endswith('GB'):\n"
            "            kib = float(mem[:-2]) * 1024 * 1024\n"
            "        elif mem.endswith('MB'):\n"
            "            kib = float(mem[:-2]) * 1024\n"
            "        elif mem.endswith('kB'):\n"
            "            kib = float(mem[:-2])\n"
            "        else:\n"
            "            kib = float(mem)\n"
            "        rows.append((rec['type'], rec['name'], kib, float(rec['price'])))\n"
            "    rows.sort(key=lambda r: r[3])\n"
            "    return [f'[{t}] {n} - {k}KiB / ${p}' for (t, n, k, p) in rows]\n"
        ),
        "tests": [
            {
                "name": "기본",
                "args": "('routers.csv',)",
                "files": {"routers.csv": "name,type,memory,price\nNetgear Nighthawk,Wi-Fi 6,1GB,199.99\nTP-Link Archer,Wi-Fi 5,512MB,89.99\nAsus RT,Wi-Fi 6,1024kB,129.95\n"},
            },
        ],
    },
    {
        "id": "w3-grades-json",
        "week": 3,
        "title": "성적 CSV → 계층형 딕셔너리",
        "difficulty": "보통",
        "tags": ["파일 입력", "try-except", "중첩 딕셔너리"],
        "summary": "플랫한 성적 CSV를 계층형 구조로 파싱한다.",
        "statement_md": (
            "쉼표로 구분된 성적 파일 `grades.csv` 의 각 줄은 "
            "`학교명,학년,반,이름,점수` 입니다. 이를 "
            "`{학교: {학년: {반: {이름: 점수}}}}` 계층형 딕셔너리로 파싱하는 "
            "`parse_grades(filepath)` 함수를 작성하세요. 학년·반은 **문자열 키**로 둡니다.\n\n"
            "입력 `grades.csv`:\n```\n과학영재교,2,1,홍길동,95\n과학영재교,2,1,이순신,N/A\n"
            "과학영재교,2,2,장영실,100\n```\n"
            "출력: `{'과학영재교': {'2': {'1': {'홍길동': 95, '이순신': 0}, '2': {'장영실': 100}}}}`"
        ),
        "constraints_md": (
            "- 점수가 `N/A` 처럼 숫자로 바꿀 수 없으면 `try-except` 로 기본값 `0` 처리하세요."
        ),
        "entry": "parse_grades",
        "starter": "def parse_grades(filepath):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def parse_grades(filepath):\n"
            "    result = {}\n"
            "    with open(filepath, encoding='utf-8') as f:\n"
            "        for line in f:\n"
            "            line = line.strip()\n"
            "            if not line:\n"
            "                continue\n"
            "            school, grade, cls, name, raw = line.split(',')\n"
            "            try:\n"
            "                score = int(raw)\n"
            "            except ValueError:\n"
            "                score = 0\n"
            "            result.setdefault(school, {}).setdefault(grade, {}).setdefault(cls, {})[name] = score\n"
            "    return result\n"
        ),
        "tests": [
            {
                "name": "기본",
                "args": "('grades.csv',)",
                "files": {"grades.csv": "과학영재교,2,1,홍길동,95\n과학영재교,2,1,이순신,N/A\n과학영재교,2,2,장영실,100\n"},
            },
            {
                "name": "빈점수",
                "hidden": True,
                "args": "('grades.csv',)",
                "files": {"grades.csv": "A고,1,3,김철수,\nA고,1,3,박영희,88\n"},
            },
        ],
    },
    {
        "id": "w3-hr-diagram",
        "week": 3,
        "title": "H-R 다이어그램 데이터 정제",
        "difficulty": "어려움",
        "tags": ["파일 입력", "try-except", "math.log10"],
        "summary": "절대 등급을 계산하고 주계열성만 걸러낸다.",
        "statement_md": (
            "관측 데이터 파일 `stars.txt` 의 각 줄은 `별ID,표면온도(K),겉보기등급(m),거리(pc)` "
            "입니다. 별의 절대 등급은 `M = m - 5*log10(d) + 5` 로 계산합니다. "
            "다음을 수행하는 `main_sequence(filepath)` 함수를 작성하세요.\n\n"
            "1. 거리가 0이거나 손상된(숫자로 변환 불가) 줄은 `try-except` 로 건너뜁니다.\n"
            "2. 표면온도가 `3000K 이상`이고 절대등급이 `-5 < M < 15` 인 별만 "
            "`(별ID, 표면온도(float), 절대등급)` 으로 모아 리스트로 반환합니다.\n"
            "3. 절대등급은 소수 둘째 자리까지 반올림(`round(M, 2)`) 합니다.\n\n"
            "채점은 부동소수 오차를 허용합니다."
        ),
        "constraints_md": (
            "- `math.log10` 을 사용하고, `ValueError`/`ZeroDivisionError` 등을 "
            "`try-except` 로 방어하세요(`pandas`/`numpy` 금지)."
        ),
        "entry": "main_sequence",
        "compare": "float",
        "starter": "import math\n\ndef main_sequence(filepath):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "import math\n"
            "def main_sequence(filepath):\n"
            "    out = []\n"
            "    with open(filepath, encoding='utf-8') as f:\n"
            "        for line in f:\n"
            "            line = line.strip()\n"
            "            if not line:\n"
            "                continue\n"
            "            parts = line.split(',')\n"
            "            try:\n"
            "                sid = parts[0]\n"
            "                temp = float(parts[1])\n"
            "                m = float(parts[2])\n"
            "                d = float(parts[3])\n"
            "                M = m - 5 * math.log10(d) + 5\n"
            "            except (ValueError, ZeroDivisionError, IndexError):\n"
            "                continue\n"
            "            if temp >= 3000 and -5 < M < 15:\n"
            "                out.append((sid, temp, round(M, 2)))\n"
            "    return out\n"
        ),
        "tests": [
            {
                "name": "혼합 데이터",
                "args": "('stars.txt',)",
                "files": {"stars.txt": "S1,5800,4.83,10\nS2,3500,2.0,0\nS3,9000,1.5,100\nS4,2500,5.0,10\nS5,6000,abc,50\nS6,4500,8.0,25\n"},
            },
        ],
    },
    {
        "id": "w3-fasta",
        "week": 3,
        "title": "FASTA 파일 상태 기반 파싱",
        "difficulty": "보통",
        "tags": ["파일 입력", "상태 변수", "join"],
        "summary": "FASTA 서열별 총 길이를 집계한다.",
        "statement_md": (
            "DNA 서열 표준 포맷 FASTA 파일 `genome.fasta` 를 파싱합니다. `>` 로 시작하는 "
            "줄은 식별자(헤더), 그 아래 여러 줄은 서열입니다. 각 식별자를 키로, 해당 서열의 "
            "**총 길이(문자 수)** 를 값으로 하는 딕셔너리를 반환하는 "
            "`parse_fasta(filepath)` 함수를 작성하세요.\n\n"
            "입력 `genome.fasta`:\n```\n>SEQ_001\nATGCGATCG\nGCTAGCTA\n>SEQ_002\nTTAACG\n```\n"
            "출력: `{'SEQ_001': 17, 'SEQ_002': 6}`"
        ),
        "constraints_md": (
            "- 상태 변수(현재 식별자)를 두고 줄 단위로 누적하세요. 문자열 `+=` 반복 대신 "
            "조각을 리스트에 모았다가 `len` 으로 길이를 구하면 효율적입니다."
        ),
        "entry": "parse_fasta",
        "starter": "def parse_fasta(filepath):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def parse_fasta(filepath):\n"
            "    result = {}\n"
            "    cur, parts = None, []\n"
            "    with open(filepath, encoding='utf-8') as f:\n"
            "        for line in f:\n"
            "            line = line.strip()\n"
            "            if not line:\n"
            "                continue\n"
            "            if line.startswith('>'):\n"
            "                if cur is not None:\n"
            "                    result[cur] = len(''.join(parts))\n"
            "                cur, parts = line[1:], []\n"
            "            else:\n"
            "                parts.append(line)\n"
            "    if cur is not None:\n"
            "        result[cur] = len(''.join(parts))\n"
            "    return result\n"
        ),
        "tests": [
            {
                "name": "기본",
                "args": "('genome.fasta',)",
                "files": {"genome.fasta": ">SEQ_001\nATGCGATCG\nGCTAGCTA\n>SEQ_002\nTTAACG\n"},
            },
            {
                "name": "단일 서열",
                "hidden": True,
                "args": "('genome.fasta',)",
                "files": {"genome.fasta": ">G1\nAAAA\nTTTT\nGG\n"},
            },
        ],
    },
    # ─────────────────────────────── 4주차 ───────────────────────────────
    {
        "id": "w4-tree-size",
        "week": 4,
        "title": "폴더 트리 용량 계산 (재귀)",
        "difficulty": "보통",
        "tags": ["재귀", "isinstance"],
        "summary": "중첩 딕셔너리로 표현된 파일 트리의 총 용량을 구한다.",
        "statement_md": (
            "파일 시스템은 폴더 안에 파일이 있고 또 하위 폴더가 중첩된 재귀적 구조입니다. "
            "딕셔너리로 표현된 파일 트리에서 모든 파일의 총 용량을 계산하는 "
            "`total_size(data)` 함수를 작성하세요.\n\n"
            "- 값이 딕셔너리면 하위 폴더이므로 내부를 다시 탐색합니다.\n"
            "- 값이 정수면 파일의 용량(KB)이므로 누적해 더합니다.\n\n"
            "예시 트리의 총합은 `2038` 입니다."
        ),
        "constraints_md": (
            "- 타입 검사는 `isinstance(data, dict)` 를 활용하세요. 재귀로 푸세요."
        ),
        "entry": "total_size",
        "starter": "def total_size(data):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def total_size(data):\n"
            "    total = 0\n"
            "    for v in data.values():\n"
            "        if isinstance(v, dict):\n"
            "            total += total_size(v)\n"
            "        else:\n"
            "            total += v\n"
            "    return total\n"
        ),
        "tests": [
            {"name": "예시 트리", "args": "({'Documents': {'resume.pdf': 120, 'Code': {'main.py': 15, 'utils.py': 8, 'data': {'users.csv': 45}}}, 'Downloads': {'setup.exe': 1500, 'image.png': 350}},)"},
            {"name": "평탄", "hidden": True, "args": "({'a': 1, 'b': 2, 'c': 3},)"},
            {"name": "빈 트리", "hidden": True, "args": "({},)"},
            {"name": "깊은 중첩", "hidden": True, "args": "({'x': {'y': {'z': {'f': 10}}}, 'g': 5},)"},
        ],
    },
    {
        "id": "w4-cache-decorator",
        "week": 4,
        "title": "캐싱 데코레이터 (Decorator)",
        "difficulty": "어려움",
        "tags": ["데코레이터", "메모이제이션"],
        "summary": "같은 인자는 다시 계산하지 않는 캐싱 데코레이터를 만든다.",
        "statement_md": (
            "동일한 인자로 호출될 때마다 원래 함수를 다시 실행하지 않고, 처음 계산한 결과를 "
            "저장해 두었다가 즉시 반환하는 `@cache` 데코레이터를 작성하세요.\n\n"
            "```python\ndef cache(func):\n    # 결과를 보관할 딕셔너리(캐시 장부)를 두고,\n"
            "    # 이미 본 인자면 함수 실행 없이 캐싱된 값을 반환하세요.\n    ...\n```\n\n"
            "채점에서는 데코레이터를 적용한 함수를 같은 인자로 여러 번 호출했을 때 "
            "**원래 함수 본문이 한 번만 실행되는지**, 그리고 반환값이 올바른지를 확인합니다."
        ),
        "constraints_md": (
            "- 데코레이터 구조 `def cache(func): def wrapper(*args): ...; return wrapper` 를 "
            "완성하세요. 인자(`args`)를 키로 하는 캐시 딕셔너리를 쓰세요."
        ),
        "mode": "snippet",
        "entry": "cache",
        "starter": "def cache(func):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def cache(func):\n"
            "    store = {}\n"
            "    def wrapper(*args):\n"
            "        if args in store:\n"
            "            return store[args]\n"
            "        store[args] = func(*args)\n"
            "        return store[args]\n"
            "    return wrapper\n"
        ),
        "tests": [
            {
                "name": "단일 인자 캐싱",
                "epilogue": (
                    "calls = []\n"
                    "@cache\n"
                    "def square(x):\n"
                    "    calls.append(x)\n"
                    "    return x * x\n"
                    "r1 = square(3)\n"
                    "r2 = square(3)\n"
                    "r3 = square(4)\n"
                    "r4 = square(3)\n"
                    "result = (r1, r2, r3, r4, calls)\n"
                ),
            },
            {
                "name": "다중 인자 캐싱",
                "hidden": True,
                "epilogue": (
                    "hits = []\n"
                    "@cache\n"
                    "def add(a, b):\n"
                    "    hits.append((a, b))\n"
                    "    return a + b\n"
                    "result = (add(1, 2), add(1, 2), add(2, 3), len(hits))\n"
                ),
            },
        ],
    },
    {
        "id": "w4-error-stream",
        "week": 4,
        "title": "로그 스트리밍 분석기 (Generator)",
        "difficulty": "보통",
        "tags": ["제너레이터", "yield"],
        "summary": "에러 상태코드(>=400) 로그만 실시간으로 흘려보낸다.",
        "statement_md": (
            "여러 줄로 된 접속 로그 문자열 `raw_log` 를 한 줄씩 처리하며, 상태 코드가 "
            "`400 이상`인 줄만 `{'ip': ..., 'status': ...}` 딕셔너리로 **yield** 하는 "
            "제너레이터 함수 `stream_errors(raw_log)` 를 작성하세요.\n\n"
            "- 각 줄 형식: `[날짜] [IP주소] [상태코드]` (예: `2026-05-26 192.168.0.1 404`)\n"
            "- `status` 는 정수로 변환합니다.\n\n"
            "예: 위 6줄 로그 → `[{'ip':'192.168.0.15','status':404}, "
            "{'ip':'192.168.0.45','status':500}, {'ip':'10.0.1.55','status':403}]`"
        ),
        "constraints_md": (
            "- 리스트를 반환하지 말고 `yield` 를 사용하세요(메모리 효율). "
            "채점에서 반환 객체가 실제 제너레이터인지 확인합니다."
        ),
        "mode": "snippet",
        "entry": "stream_errors",
        "starter": "def stream_errors(raw_log):\n    # 여기에 작성하세요 (yield 사용)\n    pass\n",
        "solution": (
            "def stream_errors(raw_log):\n"
            "    for line in raw_log.strip().split('\\n'):\n"
            "        date, ip, status = line.split()\n"
            "        if int(status) >= 400:\n"
            "            yield {'ip': ip, 'status': int(status)}\n"
        ),
        "tests": [
            {
                "name": "6줄 로그",
                "epilogue": (
                    "raw = ('2026-05-26 192.168.0.10 200\\n'\n"
                    "       '2026-05-26 192.168.0.15 404\\n'\n"
                    "       '2026-05-26 10.0.1.20 200\\n'\n"
                    "       '2026-05-26 192.168.0.45 500\\n'\n"
                    "       '2026-05-26 172.16.0.12 301\\n'\n"
                    "       '2026-05-26 10.0.1.55 403')\n"
                    "result = list(stream_errors(raw))\n"
                ),
            },
            {
                "name": "제너레이터 여부",
                "hidden": True,
                "epilogue": (
                    "g = stream_errors('2026-05-26 1.1.1.1 500')\n"
                    "result = (type(g).__name__, list(g))\n"
                ),
            },
        ],
    },
    {
        "id": "w4-flatten",
        "week": 4,
        "title": "중첩 리스트 평탄화 (재귀)",
        "difficulty": "보통",
        "tags": ["재귀", "isinstance"],
        "summary": "임의 깊이의 중첩 리스트를 1차원으로 편다.",
        "statement_md": (
            "임의의 깊이로 중첩된 리스트를 깨끗한 1차원 리스트로 평탄화하는 재귀 함수 "
            "`flatten(data)` 를 작성하세요. 원소의 순서는 그대로 유지되어야 합니다.\n\n"
            "- 입력: `[1, [2, [3, 4], 5], 6, [7, 8, [9]]]`\n"
            "- 출력: `[1, 2, 3, 4, 5, 6, 7, 8, 9]`"
        ),
        "constraints_md": (
            "- `isinstance(element, list)` 로 원소가 리스트인지 판별하세요. "
            "리스트가 아닌 원소를 만나면 기저 조건입니다."
        ),
        "entry": "flatten",
        "starter": "def flatten(data):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def flatten(data):\n"
            "    out = []\n"
            "    for x in data:\n"
            "        if isinstance(x, list):\n"
            "            out.extend(flatten(x))\n"
            "        else:\n"
            "            out.append(x)\n"
            "    return out\n"
        ),
        "tests": [
            {"name": "기본", "args": "([1, [2, [3, 4], 5], 6, [7, 8, [9]]],)"},
            {"name": "이중", "hidden": True, "args": "([[1, [2]], 3],)"},
            {"name": "빈리스트", "hidden": True, "args": "([],)"},
            {"name": "평탄", "hidden": True, "args": "([1, 2, 3],)"},
            {"name": "깊은중첩", "hidden": True, "args": "([[[[5]]]],)"},
        ],
    },
    {
        "id": "w4-deep-copy",
        "week": 4,
        "title": "안전한 깊은 복사 (얕은 복사 버그)",
        "difficulty": "보통",
        "tags": ["copy.deepcopy", "참조"],
        "summary": "원본 템플릿과 완전히 독립된 복사본을 만든다.",
        "statement_md": (
            "매장 매출 템플릿을 `.copy()` 로 복사했더니, 한 지점의 리스트 값을 바꾸자 "
            "다른 지점의 값까지 바뀌는 사고가 났습니다(얕은 복사로 내부 리스트가 공유됨). "
            "원본 템플릿의 **리스트 구조까지 깨끗하게 독립**된 복사본을 반환하는 "
            "`safe_copy(template)` 함수를 작성하세요.\n\n"
            "복사본의 내부 리스트를 수정해도 원본과 다른 복사본이 영향을 받지 않아야 합니다."
        ),
        "constraints_md": (
            "- 파이썬 내장 `copy` 모듈의 깊은 복사 기능을 활용하세요."
        ),
        "mode": "snippet",
        "entry": "safe_copy",
        "starter": "import copy\n\ndef safe_copy(template):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "import copy\n"
            "def safe_copy(template):\n"
            "    return copy.deepcopy(template)\n"
        ),
        "tests": [
            {
                "name": "독립성 검증",
                "epilogue": (
                    "t = {'store_name': '기본 지점', 'daily_sales': [120, 150, 90]}\n"
                    "gangnam = safe_copy(t)\n"
                    "hongdae = safe_copy(t)\n"
                    "gangnam['store_name'] = '강남점'\n"
                    "gangnam['daily_sales'][1] = 500\n"
                    "result = (hongdae['store_name'], hongdae['daily_sales'], t['daily_sales'], gangnam['daily_sales'])\n"
                ),
            },
        ],
    },
    {
        "id": "w4-orders-tax",
        "week": 4,
        "title": "주문 데이터 변환 및 세금 계산",
        "difficulty": "보통",
        "tags": ["리스트 컴프리헨션", "필터"],
        "summary": "배송완료 주문만 세후 금액으로 가공한다.",
        "statement_md": (
            "쇼핑몰 일일 주문 내역 `orders`(딕셔너리 리스트)를 회계용으로 정제합니다. "
            "복잡한 다중 for/if 대신 **단 한 줄의 리스트 컴프리헨션**으로 처리하는 "
            "`process_orders(orders)` 함수를 작성하세요.\n\n"
            "- `status` 가 `'cancelled'` 인 주문은 제외합니다.\n"
            "- `status` 가 `'completed'` 인 주문은 `price * 1.1` 을 소수 둘째 자리까지 "
            "반올림한 `tax_included_price` 를 담은 새 딕셔너리 "
            "`{'order_id':..., 'item':..., 'tax_included_price':...}` 로 변환합니다."
        ),
        "constraints_md": (
            "- 세후 금액은 `round(price * 1.1, 2)` 로 계산하세요."
        ),
        "entry": "process_orders",
        "starter": "def process_orders(orders):\n    # 여기에 작성하세요\n    pass\n",
        "solution": (
            "def process_orders(orders):\n"
            "    return [\n"
            "        {'order_id': o['order_id'], 'item': o['item'], 'tax_included_price': round(o['price'] * 1.1, 2)}\n"
            "        for o in orders if o['status'] == 'completed'\n"
            "    ]\n"
        ),
        "tests": [
            {"name": "기본", "args": "([{'order_id':101,'item':'파이썬 웹 개발 책','price':32000,'status':'completed'},{'order_id':102,'item':'맥북 충전기','price':89000,'status':'cancelled'},{'order_id':103,'item':'무선 마우스','price':45000,'status':'completed'},{'order_id':104,'item':'모니터 암','price':125000,'status':'completed'},{'order_id':105,'item':'USB 메모리','price':15000,'status':'cancelled'}],)"},
            {"name": "전부 취소", "hidden": True, "args": "([{'order_id':1,'item':'A','price':1000,'status':'cancelled'}],)"},
            {"name": "단일 완료", "hidden": True, "args": "([{'order_id':9,'item':'B','price':10000,'status':'completed'}],)"},
        ],
    },
]


# ── 빌드 ─────────────────────────────────────────────────────────────────────
def bake_and_verify():
    start_dir = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        os.chdir(tmp)
        try:
            for p in PROBLEMS:
                sol = p["solution"]
                # 1) 기대출력 굽기
                for t in p["tests"]:
                    got = harness.compute_got(sol, p, t)
                    t["expected"] = repr(got)
                # 2) 자가검증: 레퍼런스가 자기 테스트를 모두 통과해야 함
                results = harness.run_problem(sol, p)
                for t, r in zip(p["tests"], results):
                    if r["error"]:
                        raise SystemExit(
                            f"[FAIL] {p['id']} / {t['name']}: 레퍼런스 실행 오류 → {r['error']}"
                        )
                    if not r["passed"]:
                        raise SystemExit(
                            f"[FAIL] {p['id']} / {t['name']}: 레퍼런스가 기대출력과 불일치"
                            f"\n  got={r['got']}\n  exp={r['expected']}"
                        )
                # 3) (선택) 빈 풀이는 반드시 실패해야 한다 — 채점이 헐겁지 않은지 점검
                empty = "def _noop():\n    pass\n"
                empty_results = harness.run_problem(empty, p)
                if all(er["passed"] for er in empty_results):
                    raise SystemExit(
                        f"[FAIL] {p['id']}: 빈 풀이가 전부 통과함(채점이 너무 헐거움)"
                    )
        finally:
            os.chdir(start_dir)


def to_public(problem):
    """problems.json 으로 내보낼 형태 — 레퍼런스 풀이와 숨은 테스트는 제외."""
    keep = {
        "id", "week", "title", "difficulty", "tags", "summary",
        "statement_md", "constraints_md", "mode", "entry", "compare",
        "starter", "tests",
    }
    out = {k: v for k, v in problem.items() if k in keep}
    tests = problem.get("tests") or []
    out["hidden_test_count"] = sum(1 for t in tests if t.get("hidden"))
    out["tests"] = [{**t, "hidden": False} for t in tests if not t.get("hidden")]
    out.setdefault("mode", "function")
    out.setdefault("compare", "value")
    return out


def main():
    bake_and_verify()
    payload = {
        "version": 1,
        "weeks": {
            "1": "파이써닉 코드와 고급 자료구조",
            "2": "탐색 및 패턴 인식 알고리즘",
            "3": "파일 입출력 기반 데이터 파이프라인",
            "4": "파이썬 심화와 실무형 성능 최적화",
        },
        "problems": [to_public(p) for p in PROBLEMS],
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"✓ {len(PROBLEMS)}개 문제 빌드 완료 → {os.path.relpath(OUT_PATH, ROOT)}")
    # 통계
    by_week = {}
    for p in PROBLEMS:
        by_week.setdefault(p["week"], 0)
        by_week[p["week"]] += 1
    for wk in sorted(by_week):
        print(f"  {wk}주차: {by_week[wk]}문제")


if __name__ == "__main__":
    main()
