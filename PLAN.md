# PLAN — HTML/CSS → React/Vue Componentize Skill

> Claude Code skill that converts HTML+CSS into React or Vue components
> **deterministically** and with **verified fidelity**.

---

## 0. Thesis — why this can be deterministic

LLM 단독 변환이 실패하는 근본 원인은 하나다: **LLM이 원본 소재를 "재작성"한다.**

- 스타일: computed style로 CSS를 재생성 → 캐스케이드·반응형·유지보수성 전멸
- 콘텐츠: 리스트 텍스트를 다시 타이핑 → 문구가 조용히 바뀜
- 구조: 마크업을 눈대중으로 재배치 → 누락/중복

**원칙: LLM은 재구성(restructure)만 하고, 원본 소재는 절대 재작성(re-author)하지 않는다.**
authored CSS·원본 텍스트·DOM 서브트리는 **스크립트로 추출해 그대로 이관**한다.
computed style은 **생성에 절대 쓰지 않고 검증 오라클로만** 쓴다. ← 핵심 방어선.

결정론 = 비트 단위 동일이 아니라, **반복 가능한 절차 + 검사 가능한 산출물 + 통과 게이트**.
모호함은 추측이 아니라 인터뷰(사용자 결정)로 해소한다.

---

## 1. Locked decisions

| 항목 | 결정 |
|---|---|
| 검증 강도 | **실제 헤드리스 브라우저 diff** (Playwright: 픽셀 + DOM) |
| 프레임워크 | **React + Vue 둘 다** (런타임 인터뷰로 선택) |
| 기본 스타일 전략 | **CSS Modules로 이관** (인터뷰에서 변경 가능) |
| 스킬 형태 | `SKILL.md`(오케스트레이션) + `scripts/`(결정론 엔진) + `templates/` + `references/` |
| 자산 재사용 | 기존+생성 컴포넌트를 **영속 인덱스**로 관리, 매 실행 재사용 |

---

## 2. Architecture — typed artifacts + gates pipeline

각 단계는 검사 가능한 JSON/파일을 산출하고, 게이트 통과 전엔 다음 단계로 못 넘어간다.
무거운 일은 `scripts/`(결정론), 판단은 LLM.

| # | 단계 | 산출물 | 누가 | 게이트 |
|---|---|---|---|---|
| 0 | **Detect + Interview** | `detected.json` → `config.json` | script 감지 → LLM 확인 | framework/styling/mode/outDir 확정 |
| 0.5 | **Index workspace** | `.componentize/workspace-index.json` | script | (통합 모드일 때) 인덱스 생성됨 |
| 1 | **Parse** | `source-map.json` | script | DOM·CSS·에셋 파싱 성공 |
| 2 | **Classify boundaries** | `boundaries.json` | script 후보 → LLM 확정 | 모든 노드 분류됨 |
| 3 | **Extract data** | `data-spec.json` | script(diff) | 텍스트 verbatim 복사 검증 |
| 4 | **Codegen** | 컴포넌트 파일 + `.module.css` | script(CSS) + LLM(배선) | computed style 미사용 |
| 4.5 | **Reuse decision** | `reuse-decision.json` | LLM + index | 인덱스 중복 생성 0 |
| 5 | **Verify fidelity** | `verify-report.json` | script(Playwright) | 픽셀 diff < 임계치 |

### 산출물 계약 상세
- **config.json**: `framework`(react/vue), `lang`(ts/js), `styling`(cssModules 디폴트), `mode`(integrate/greenfield), `targetPath`, `assetStrategy`, `viewports[]`
- **source-map.json**: DOM 트리 + 노드별 적용 CSS 룰 + 에셋 목록
- **boundaries.json**: 노드별 라벨 `layout | reuse(→existing) | new-component | leaf-markup` + 구조 해시 + confidence
- **data-spec.json**: 리스트별 prop 인터페이스 + 데이터 배열(텍스트는 원본 복사)
- **reuse-decision.json**: 재사용 vs 신규 생성 감사표
- **verify-report.json**: viewport별 픽셀 diff %, DOM diff, 실패 영역, unknowns 원장(복원 못 한 인터랙션 flag)

---

## 3. Node classification (layout ≠ component)

2단계는 "모든 요소=컴포넌트"가 아니라 **분류**다.

- **layout** — 페이지 스캐폴딩, grid/flex 래퍼(`container/wrapper/row/col/page`), positioning-only CSS, 비반복, 큰 서브트리 → 레이아웃 셸/기존 셸 재사용, props 추출 안 함
- **reuse** — 인덱스의 기존 컴포넌트와 매칭 → 생성 금지, import+props 배선
- **new-component** — 반복 또는 경계 뚜렷한 의미 단위 → 신규 생성
- **leaf-markup** — `<p>/<span>` 등 분리 불필요

휴리스틱 신호(스크립트 1차): 클래스명 패턴, CSS positioning-only 여부, 반복 여부, 서브트리 크기 → LLM 확정.

---

## 4. Reuse indexing (기존 + 생성 자산)

**`.componentize/workspace-index.json`** — 타겟 워크스페이스에 영속, *살아있는* 인덱스.
사전 존재 + 스킬 생성물 **둘 다** 포함 → 페이지 여러 개 변환 시 중복 생성 방지.

```json
{ "name": "...", "path": "...", "framework": "react|vue",
  "props": ["..."], "structuralSignature": "hash",
  "kind": "component|layout", "source": "existing|generated" }
```

- **인덱스 단계**: `.tsx/.jsx/.vue` 스캔 → 이름·props(defineProps/interface)·구조 시그니처 추출, UI lib import 감지
- **매칭 트릭**: 2단계 **구조 해시를 조인 키로 재활용** → 새 반복 서브트리 해시로 인덱스 룩업, LLM이 의미·props로 확정
- **재인덱스**: 4단계 코드젠 후 생성물 append

---

## 5. File tree

```
html-componentize-skill/
├─ SKILL.md                     # 오케스트레이션 플레이북 (단계별 게이트)
├─ scripts/                     # 결정론 엔진 (Node, .mjs)
│  ├─ detect-project.mjs        # 0: 프로젝트 자동 감지 → detected.json
│  ├─ parse-source.mjs          # 1: HTML+CSS → source-map.json
│  ├─ index-workspace.mjs       # 0.5: 기존+생성 → workspace-index.json
│  ├─ detect-boundaries.mjs     # 2: 분류 + 구조해시 + 인덱스 룩업
│  ├─ extract-data.mjs          # 3: 인스턴스 diff → props + 데이터
│  ├─ css-to-modules.mjs        # 4: postcss → .module.css + class맵
│  ├─ verify-fidelity.mjs       # 5: Playwright 스샷+DOM diff
│  └─ package.json              # parse5, postcss, playwright, pixelmatch, pngjs
├─ templates/{react,vue}/       # 코드젠 스캐폴드
├─ references/
│  ├─ interview.md              # 0단계 질문지
│  └─ principles.md             # "재작성 금지" 도큐먼트
└─ .componentize/               # (타겟 워크스페이스에 생성됨, 영속 인덱스)
```

### LLM vs script 분담
- **script(결정론)**: 파싱, 구조 해시, 인스턴스 diff, CSS→Modules 변환, 스샷 비교, 인덱싱
- **LLM(판단)**: 경계 분류 확정, 네이밍, 재사용 매칭 확정, JSX/SFC 조립, 검증 실패 디버깅

---

## 6. Build order

1. **scripts 결정론 코어** (검증 가능한 핵심부터)
   - `parse-source.mjs` → `detect-boundaries.mjs` → `extract-data.mjs`
   - `css-to-modules.mjs` → `index-workspace.mjs` → `verify-fidelity.mjs`
2. **templates/** React/Vue 스캐폴드
3. **SKILL.md** 플레이북 (단계 호출·게이트·인터뷰)
4. **references/** interview.md, principles.md
5. **end-to-end 스모크 테스트**: 샘플 HTML(반복 리스트 + 레이아웃 + 기존 컴포넌트 1개) → 변환 → 픽셀 diff 통과 확인

---

## 7. Open questions / risks

- Playwright 의존성 설치 부담(Windows) — 검증 단계 옵션화 vs 필수화
- 구조 해시 매칭의 false positive — confidence 임계치 + LLM 확정으로 완화
- 반응형/미디어쿼리 충실도 — viewport 다중 검증으로 커버
- 동적 콘텐츠(데이터 바인딩 의도) vs 정적 반복 구분 — 인터뷰/flag로 처리

---

## 8. Market research

**결론: 우리가 노리는 교집합을 점유한 도구는 없다.** 시장은 두 진영으로 갈리고
각자 우리 축을 놓친다.

### Landscape
| 도구 | 입력→출력 | 방식 | CSS 보존 | 기존 컴포넌트 재사용 | 충실도 검증 |
|---|---|---|---|---|---|
| html-react-parser, htmltojsx | HTML→JSX | 런타임 파싱/순진한 코드젠 (class→className, style 문자열→객체) | 부분 | ✗ | ✗ |
| html-to-vue, vue-template-loader | HTML→Vue | 런타임/빌드 템플릿 컴파일 | ✗ | 부분 | ✗ |
| v0.dev | prompt/image→React | LLM 생성, Tailwind+shadcn 재작성 | ✗(재작성) | shadcn만 | ✗ |
| Locofy.ai, Anima | **Figma**→코드 | AI+휴리스틱 | 재작성 | 제한적(Figma) | ✗ |
| **Builder.io Visual Copilot** | **Figma**→코드 | AI 시맨틱 매칭 + Component Indexing | 토큰화 | **있음(가장 근접)** | ✗ |
| TeleportHQ | HTML 임포트→사이트 | 컴포넌트 자동 추출 | 부분 | 새 라이브러리 생성 | ✗ |

### 채워지지 않은 갭
1. **HTML 입력이 버려져 있다.** 잘 되는 도구(Locofy/Anima/Builder)는 전부 **Figma 입력**.
   HTML 입력 도구는 순진한 파서이거나 사이트빌더 재작성. authored HTML+CSS를 source of truth로 취급하는 곳이 없음.
2. **CSS 캐스케이드가 버려진다.** `getComputedStyle` 기반 변환이 "요소당 200+ 속성"을 뱉는 문제는
   문서로 확인됨(thecandidstartup.org). 다들 computed 인라인 bloat이거나 Tailwind 재작성으로 도망.
3. **컴포넌트 재사용은 Figma+AI 한정.** Builder.io 매핑은 실재하나 입력이 Figma,
   매칭이 **AI 시맨틱(~70% 자동 정확도)**, "결정론적"은 사용자가 매핑 함수 손수 작성할 때만.
4. **충실도 검증은 변환 도구에 전무.** 픽셀 diff/비주얼 회귀는 별도 QA 산업(Applitools 등).
   **자기 출력을 렌더해 원본과 diff하는 변환 도구는 0개.** 전부 best-effort + "20~30% 수작업 정리 예상".

### 왜 아직 좋은 게 없나
- **시장 중력이 design-first.** 신규 프로젝트는 Figma에서 시작 → 예산 있는 퍼널로 최적화.
  HTML→컴포넌트는 *마이그레이션* 잡(레거시/CMS/이메일/스크랩 UI) — 작고 안 멋지고 SaaS 후킹 없음.
- **결정론은 AI 코드젠 비즈니스 모델과 충돌.** LLM이 데모가 잘 되고 일반화됨.
  결정론적 AST+캐스케이드 변환은 unsexy 엔지니어링 + 해자 서사 없음.
- **CSS 캐스케이드를 제대로 하기 진짜 어렵다.** 실제 브라우저(→bloat) 아니면 풀 캐스케이드 리졸버 필요.
  대부분 Tailwind 재작성으로 punt = authored CSS 포기 = 보존의 정반대.
- **아무도 루프를 안 닫는다.** 변환과 비주얼 검증이 다른 제품 카테고리 → "변환 후 동일함을 증명"이 한 도구에 없음.

### 우리의 wedge (아무도 점유 안 한 교집합)
**HTML+CSS 입력 · 캐스케이드 보존 결정론 코드젠 · 기존 컴포넌트 인덱싱+재사용(Figma/AI추측 아님) · 렌더+픽셀 diff 게이트.**
Builder.io가 재사용 매핑을 건드리는 유일한 도구이나 Figma 전용·AI 확률적·미검증.

> 참고: builder.io/blog/visual-copilot, builder.io/c/docs/component-indexing,
> locofy.ai/docs/custom-components, teleporthq.io/html-to-website-converter,
> thecandidstartup.org/2024/08/26/css-react-components.html
