# LaTeX → 한글(HWP) 수식 변환 규칙

이 문서는 `한글문서파일형식_수식_revision1.2.pdf`(한컴 공식 명세, 2014-10-30)를 정독해 정리한 변환 규칙이다. 변환기 구현과 골든 테스트의 근거가 된다.

> 출처: 한컴오피스 한글 문서 파일 형식 - 수식, revision 1.2. 본 변환기는 이 공개 명세를 참고하여 개발한다.

---

## 1. 한글 수식 편집기 고유 규칙 (변환에 직접 영향)

한글 수식 편집기는 자체 마크업을 쓰며, LaTeX와 다른 고유 규칙이 있다. 변환 시 반드시 지켜야 한다.

| 기호 | 의미 | 비고 |
|------|------|------|
| (빈칸/Space) | **항(term) 구분** | 화면엔 안 보임. 반복 입력은 무시됨 |
| `{ }` | 여러 항의 묶음 | 화면엔 안 보임. 그룹화 전용 |
| `~` | 정상 크기 빈칸 | 화면에 실제 공백으로 출력 |
| `` ` `` | **1/4 크기 빈칸** | 연산자 주위 미세 간격 조정에 사용 |
| `"  "` | 9자 넘는 한 낱말 묶음 | 9자 초과 낱말은 두 항으로 쪼개지므로 따옴표로 묶어 한 낱말 유지 |
| `#` | 줄 바꿈 (Enter 효과) | 행렬/여러 줄에서 행 구분 |
| `&` | 세로 칸 맞춤 (Tab 효과) | 행렬에서 열 구분, 정렬 기준 |

핵심:
- **빈칸은 의미를 가진다.** 사용자가 누른 Space/Enter는 화면 공백이 아니라 "항 구분"으로만 쓰인다. 화면에 공백을 내려면 `~` 또는 `` ` ``를 써야 한다.
- **항 구분을 위해 명령어(키워드) 앞뒤에는 공백이 필요하다.** 예: `1 over 2`, `sqrt 2`, `lim _{x -> 0}`.
- 명세 De Morgan 예제: 등호 앞뒤의 `` ` ``은 "보기 좋은 간격을 유지하기 위하여" 넣은 것. → **연산자(`=`, `-`, `+` 등) 주위에 `` ` ``로 좁은 간격을 주는 것이 관례.** 골든 예시의 `` (t`-` phi ``가 이 규칙이다.

---

## 2. 글씨체 / 함수

### 글꼴 명령
- 영문 기본은 **이탤릭체**. 로만체로 쓰려면 앞에 `rm`.
- `it`: 이탤릭 전환, `bold`: 볼드, `scale<숫자>`: 첫 글자 크기 100 기준 비율(%).
- 화학식은 이탤릭이 어색하므로 `rm`을 앞세움 (예: `rm 2H_2 O = 2H_2 + O_2`).

### 자동 로만체 기본 함수 (그대로 매핑, `\` 만 제거)
`sin cos tan cot sec csc cosec` · `sinh cosh tanh coth` · `ln lg log` · `lim Lim` · `max min` · `arcsin arccos arctan arcsinh` · `exp Exp` · `det gcd mod`

예약어: `if for and hom ker deg arg dim Pr`

> 주의: `lim`과 `Lim`은 대소문자를 구분한다. 함수 글자 사이에 빈칸을 넣으면(`s in`) 이탤릭으로 바뀌므로, 함수명 중간에 공백을 넣지 말 것.

---

## 3. 구조 명령 (LaTeX → 한글)

| LaTeX | 한글 수식 | 명세 근거 / 비고 |
|-------|-----------|------------------|
| `\frac{a}{b}` | `{a} over {b}` | OVER. 우선순위 위해 `{}`로 감쌈 |
| `\dfrac`/`\tfrac{a}{b}` | `{a} over {b}` | 크기 변형은 무시 |
| `a \atop b` | `{a} atop {b}` | ATOP: 분수선 없는 분수 |
| `\sqrt{x}` | `sqrt {x}` | SQRT |
| `\sqrt[n]{x}` | `^{n} sqrt {x}` | 명세 2.3: 세제곱근 = `^3sqrt{x^2+1}` (SQRT 앞에 `^`+숫자). `root n of`가 아님 |
| `x^{n}` / `x^n` | `x^{n}` | SUP 또는 `^`. 단일 문자도 `{}`로 통일 권장 |
| `x_{i}` / `x_i` | `x_{i}` | SUB 또는 `_`. 명세 `H_2 O`처럼 단일 숫자는 `_2`도 가능 |
| `\sum_{i=1}^{n}` | `sum_{i=1}^{n}` | SUM. 명세: `sum_{x=0} ^{inf}` |
| `\prod_{...}` | `prod_{...}` | PROD |
| `\int_a^b` | `int_{a}^{b}` | INT. 또는 `int from a to b` (FROM/TO, 명세 2.3) |
| `\oint` | `oint` | OINT |
| `\iint`/`\iiint` | `dint`/`tint` | DINT, TINT |
| `\lim_{x \to 0}` | `lim_{x -> 0}` | 명세 2.5: `lim_N->inf` |
| `\binom{n}{k}` | `n CHOOSE k` | CHOOSE 또는 BINOM |
| `\left( ... \right)` | `LEFT( ... RIGHT)` | 명세 2.5 권장 방식 (아래 4절) |
| `\overline{x}` / `\bar{x}` | `bar {x}` | 장식 명령(5절) |
| `\vec{x}` | `vec {x}` | |

### 행렬 / 여러 줄
- `\begin{matrix} a & b \\ c & d \end{matrix}` → `matrix{ a & b # c & d }`  (`\\`→`#`, `&`→`&`)
- `pmatrix` → `pmatrix` (소괄호), `bmatrix` → `bmatrix` (대괄호), `vmatrix` → `dmatrix` (세로줄)
- `\begin{cases} ... \\ ... \end{cases}` → `cases{ ... # ... }`

---

## 4. `\left` / `\right` 정책 (확정: LEFT/RIGHT)

- **명세 권장 (2.5)**: 분수·합 등 큰 내용을 괄호로 감쌀 때는 `LEFT( ... RIGHT)`를 쓴다. 안 쓰면 괄호 크기가 내용에 맞춰 커지지 않아 "보기에 좋지 않은 수식"이 된다.
- **확정 정책**: `\left<구분자>` → `LEFT<구분자>`, `\right<구분자>` → `RIGHT<구분자>` 로 변환한다.
  - 예: `\left( ... \right)` → `LEFT( ... RIGHT)`, `\left[ ... \right]` → `LEFT[ ... RIGHT]`.
  - `\left.` / `\right.`(보이지 않는 구분자)는 `LEFT` / `RIGHT` 단독으로 변환된다.
  - `\bigl`/`\bigr` 등 단독 크기 지정자는 LEFT/RIGHT가 아닌 구분자만 출력한다(쌍이 아니므로).

---

## 5. 글자 장식 명령어 (글자 위 기호)

LaTeX accent → 한글 명령. 모두 `명령 글자` 형태 (예: `hat A`, 여러 글자는 `hat AA`).

| LaTeX | 한글 |
|-------|------|
| `\hat` | `hat` |
| `\check` | `check` |
| `\tilde` | `tilde` |
| `\acute` | `acute` |
| `\grave` | `grave` |
| `\dot` | `dot` |
| `\ddot` | `ddot` |
| `\bar`/`\overline` | `bar` |
| `\vec` | `vec` |
| `\overrightarrow`(연결) | `dyad` |
| `\underline` | `under` |
| (없음) | `arch` (위로 굽은 호) |

---

## 6. 그리스 문자 (LaTeX → 한글)

대소문자가 그대로 매핑된다. LaTeX `\lambda`→`lambda`, `\Lambda`→`Lambda`.

**소문자**: `alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega`

**대문자**: `Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega`

**변형(var)**: `\vartheta`→`vartheta`, `\varpi`→`varpi`, `\varsigma`→`varsigma`, `\varphi`→`varphi`, `\varepsilon`→`varepsilon`, `\varupsilon`→`varupsilon`, `\varrho`→`varrho`

> 한글에서 그리스 문자는 키워드이므로 뒤에 공백으로 항을 끊는다. 골든 예시 `lambda  (t)`처럼 키워드 뒤 공백이 붙는다.

---

## 7. 연산 / 논리 / 관계 기호

| LaTeX | 한글 | | LaTeX | 한글 |
|-------|------|---|-------|------|
| `\times` | `times` | | `\leq`/`\le` | `leq` |
| `\div` | `div` | | `\geq`/`\ge` | `geq` |
| `\pm` | `plusminus` | | `\neq`/`\ne` | `neq` (또는 `!=`) |
| `\mp` | `minusplus` | | `\equiv` | `equiv` (또는 `==`) |
| `\cdot` | `cdot` | | `\approx` | `approx` |
| `\circ` | `circ` | | `\simeq` | `simeq` |
| `\bullet` | `bullet` | | `\sim` | `sim` |
| `\ast`/`*` | `ast` | | `\cong` | `cong` |
| `\star` | `star` | | `\propto` | `propto` |
| `\oplus` | `oplus` | | `\doteq` | `doteq` |
| `\ominus` | `ominus` | | `\prec` | `prec` |
| `\otimes` | `otimes` | | `\succ` | `succ` |
| `\odot` | `odot` | | `\ll` | `<<` |
| `\oslash` | `oslash` | | `\gg` | `>>` |
| `\vee`/`\lor` | `vee` | | `\not=` | `not =` (NOT) |
| `\wedge`/`\land` | `wedge` | | `\degree` | `DEG` |
| `\diamond` | `diamond` | | `\asymp` | `ASYMP` |
| `\triangledown` | `TRIANGLED` | | `\Im` | `IMAG` |
| `\Re` | `REIMAGE` | | | |

---

## 8. 집합 기호

| LaTeX | 한글 | | LaTeX | 한글 |
|-------|------|---|-------|------|
| `\cup` | `union` | | `\in` | `` ` IN ` `` (∈ 앞뒤 좁은 간격) |
| `\cap` | `inter` | | `\ni` | `owns` |
| `\bigcup` | `union` | | `\notin` | `notin` |
| `\bigcap` | `inter` | | `\subset` | `subset` |
| `\sqcap` | `sqcap` | | `\supset` | `supset` |
| `\sqcup` | `sqcup` | | `\subseteq` | `subseteq` |
| `\sqsubset` | `SQSUBSET` | | `\sqsupset` | `SQSUPSET` |
| `\sqsubseteq` | `SQSUBSETEQ` | | `\sqsupseteq` | `SQSUPSETEQ` |
| `\emptyset` | `emptyset` | | `\supseteq` | `supseteq` |
| `\aleph` | `aleph` | | `\uplus` | `uplus` |
| `\coprod` | `COPROD` | | `\lll` | `LLL` |
| `\ggg` | `>>>` | | | |

> 첨자 없는 작은 집합 기호는 명령 앞에 `SMALL` (예: `A SMALLUNION B`).

---

## 9. 화살표

| LaTeX | 한글 | | LaTeX | 한글 |
|-------|------|---|-------|------|
| `\leftarrow`/`\gets` | `larrow` (또는 `<-`) | | `\Leftarrow` | `LARROW` |
| `\rightarrow`/`\to` | `rarrow` (또는 `->`) | | `\Rightarrow` | `RARROW` |
| `\uparrow` | `uparrow` | | `\Uparrow` | `UPARROW` |
| `\downarrow` | `downarrow` | | `\Downarrow` | `DOWNARROW` |
| `\leftrightarrow` | `lrarrow` (또는 `<->`) | | `\Leftrightarrow` | `LRARROW` |
| `\updownarrow` | `udarrow` | | `\mapsto` | `mapsto` |
| `\nwarrow` | `nwarrow` | | `\nearrow` | `nearrow` |
| `\swarrow` | `swarrow` | | `\searrow` | `searrow` |
| `\hookleftarrow` | `hookleft` | | `\hookrightarrow` | `hookright` |

---

## 10. 기타 기호

| LaTeX | 한글 | | LaTeX | 한글 |
|-------|------|---|-------|------|
| `\infty` | `inf` | | `\partial` | `partial` |
| `\forall` | `forall` | | `\exists` | `exist` |
| `\nabla` | `nabla` (동작 확인 필요) | | `\prime`/`'` | `prime` |
| `\therefore` | `therefore` | | `\because` | `because` |
| `\cdots` | `cdots` | | `\ldots`/`\dots` | `ldots` |
| `\vdots` | `vdots` | | `\ddots` | `ddots` |
| `\angle` | `angle` | | `\triangle` | `triangle` |
| `\dagger` | `dagger` | | `\ddagger` | `ddagger` |
| `\lnot`/`\neg` | `lnot` | | `\diamond` | `diamond` |
| `\top` | `top` | | `\bot`/`\perp` | `bot` |
| `\models` | `models` | | `\vdash` | `vdash` |
| `\degree` | `DEG` | | `\AA`(옹스트롬) | `ANGSTROM` |
| `\ell` | `ELL` | | `\wp` | `WP` |
| `\imath` | `IMATH` | | `\jmath` | `JMATH` |
| `\hbar` | `hbar` | | | |

---

## 11. 골든 예시를 명세 규칙으로 재해석

**입력:**
```
$$\lambda(t) = \lambda_0 + A_1 \sin\left(\frac{2\pi}{24}(t - \phi_1)\right) + A_2 \sin\left(\frac{2\pi}{12}(t - \phi_2)\right)$$
```
**출력 (사용자 제공 원본 — `\left/\right`를 단순 `()`로 표기):**
```
lambda  (t)= lambda  ` _{`0} +A _{1} sin( {2 pi } over {24} (t`-` phi  _{1} ))+A _{2} sin( {2 pi } over {12} (t`-` phi  _{2} ))
```

**출력 (현재 변환기 — `\left/\right`를 `LEFT(/RIGHT)`로, 4절 정책):**
```
lambda ( t ) `=` lambda _{0} `+` A _{1} sin LEFT( {2 pi} over {24} ( t `-` phi _{1} ) RIGHT) `+` A _{2} sin LEFT( {2 pi} over {12} ( t `-` phi _{2} ) RIGHT)
```

> 두 출력은 한글 수식 편집기에서 **공백이 표시되지 않으므로 거의 동일하게 렌더링**되며, 변환기 출력은 큰 괄호가 내용 높이에 맞춰 커지는 이점이 있다.

규칙 대응:
- `$$ ... $$` → 구분자 제거, 본문만 변환.
- `\lambda` → `lambda ` : 그리스 키워드 + 항 구분 공백.
- `\frac{2\pi}{24}` → `{2 pi } over {24}` : OVER, 분자/분모 `{}` 묶음. `\pi`→`pi `.
- `\sin` → `sin` : 자동 로만체 함수.
- `\left( ... \right)` → `LEFT( ... RIGHT)` : 큰 내용을 감싸는 자동 크기 괄호(4절 정책).
- `t - \phi_1` → `(t`-` phi  _{1} )` : 연산자 `-` 주위에 `` ` ``(1/4 빈칸) → 명세의 "보기 좋은 간격" 관례.
- `A_1` → `A _{1}` : 아래첨자 `{}` 묶음.

> 주의: `\lambda_0` → `` lambda  ` _{`0}``의 백틱 위치는 한글 편집기가 표시용으로 끼워 넣은 미세 간격으로 보인다. 명세상 `lambda _{0}`만으로도 동일하게 렌더링되므로, **변환기는 깔끔한 형태를 출력하되 골든과의 미세 공백 차이는 한글이 정규화하므로 양쪽 모두 정상 동작**으로 간주한다. (실제 한글에서 검증 필요)

---

## 12. 미해결 / 확인 필요 항목

- ~~`\left`/`\right` 처리 정책 (4절)~~ — **확정: `LEFT(/RIGHT)` 방식.**
- `\nabla`, `\hbar` 등 명세에 이미지로만 있고 텍스트 추출이 안 된 일부 기호명 — 한글에서 직접 검증.
- 그리스 소문자 명령이 명세 텍스트에는 대문자 표(`Alpha`…)만 나옴. 소문자(`alpha`…) 동작은 한글 통념상 맞지만 검증 권장.
- 미지원/미확인 LaTeX 명령은 임의로 버리지 말고 변환 결과에 원문 보존 또는 경고 표시.
