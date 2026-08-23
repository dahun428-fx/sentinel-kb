/**
 * 유형별 서사 템플릿 — specs/08-publishing.md §4 "유형별 서사 템플릿 (구조 로테이션)".
 *
 * > "같은 유형이라도 템플릿 3종을 로테이션해 구조 획일화를 피한다.
 * >  예: 케이스 스터디 = (a) 시간순 수사 서사, (b) 결론 선행 후 역추적,
 * >  (c) 잘못된 가설 3개를 기각하는 구성."
 *
 * ## 왜 아웃라인을 **모델이 아니라 코드가** 만드는가 (결정)
 *
 * §4의 파이프라인 첫 단계는 "아웃라인 생성"이지만 **누가** 만드는지는 적혀 있지 않다.
 * 여기서는 코드가 만든다. 근거 셋:
 *
 * 1. **§0-1의 분업 그대로다** — "팩트는 코드가, 서사는 모델이". 아웃라인은 구조이지 서사가
 *    아니다. 구조를 모델에게 맡기면 §4가 막으려는 바로 그 획일화(모든 글이 같은 뼈대)가
 *    모델의 사전확률에서 나온다. 로테이션은 그 사전확률을 이기려는 장치인데, 골격 선택을
 *    다시 모델에 돌려주면 장치가 무력화된다.
 * 2. **모델 호출이 하나 줄어든다.** 재작성 상한 2회와 합쳐 최악 호출 수가 4회에서 3회가 된다.
 * 3. **결정론이 유지된다.** T-029가 아티클 멱등성을 소스 집합 해시에 걸었고 T-030이 팩트를
 *    결정론으로 만들었다. 아웃라인까지 결정론이면 같은 소스 집합은 항상 같은 골격으로 간다.
 *
 * ## 로테이션은 무작위가 아니다
 *
 * `Math.random()`을 쓰면 같은 아티클을 두 번 만들 때 골격이 달라지고, T-030이 지킨 결정론이
 * 여기서 깨진다. 소스 레코드 ID 집합의 해시를 3으로 나눈 나머지를 쓴다 — 아티클마다 다르고,
 * 같은 아티클에서는 언제나 같다.
 */
import type { ArticleKind } from "@sentinel/contracts";

import type { ArticleFacts } from "../facts/types.js";

/** 골격의 한 마디. `guidance`는 모델에게 주는 지시이지 본문에 그대로 실리는 문장이 아니다. */
export interface TemplateSection {
  readonly heading: string;
  readonly guidance: string;
}

export interface ArticleTemplate {
  readonly id: string;
  readonly kind: ArticleKind;
  readonly name: string;
  /** 첫 문단을 어떻게 열 것인가. §4의 "사건 한복판에서 시작"이 여기서 구체화된다. */
  readonly opening: string;
  readonly sections: readonly TemplateSection[];
}

/** §4가 정한 로테이션 폭. */
export const TEMPLATES_PER_KIND = 3;

/**
 * 골격 12종(유형 4 × 3). 케이스 스터디 셋은 §4가 예시로 든 (a)·(b)·(c) 그대로다.
 * 나머지 유형의 셋은 같은 원리 — **같은 재료를 다른 순서로 훑는 세 가지 방법** — 로 만들었다.
 */
export const ARTICLE_TEMPLATES: readonly ArticleTemplate[] = [
  {
    id: "case-chronological",
    kind: "case",
    name: "시간순 수사 서사",
    opening: "사건이 처음 관측된 순간의 증상과 그때 화면에 뜬 문자열로 연다.",
    sections: [
      { heading: "처음 본 것", guidance: "최초 증상과 에러 원문. 해석은 아직 하지 않는다." },
      { heading: "추적", guidance: "실행한 진단 명령과 그 출력. 타임라인의 날짜를 그대로 쓴다." },
      { heading: "원인", guidance: "레코드의 rootCause를 근거로 인과를 설명한다." },
      { heading: "해결", guidance: "실제로 적용한 조치. 명령어는 팩트 팩의 원문 그대로." },
      { heading: "남은 것", guidance: "재발 방지와 아직 닫히지 않은 축." },
    ],
  },
  {
    id: "case-conclusion-first",
    kind: "case",
    name: "결론 선행 후 역추적",
    opening: "한 줄로 원인을 먼저 말하고, 그 한 줄에 도달하기까지 무엇이 걸렸는지로 넘어간다.",
    sections: [
      { heading: "원인은 이것이었다", guidance: "결론부터. 근거 수치를 함께 붙인다." },
      { heading: "왜 바로 안 보였나", guidance: "증상이 원인을 가린 방식." },
      { heading: "되짚기", guidance: "타임라인을 거꾸로 훑으며 각 단계에서 무엇을 놓쳤는지." },
      { heading: "조치", guidance: "적용한 해결과 그 뒤의 상태." },
    ],
  },
  {
    id: "case-rejected-hypotheses",
    kind: "case",
    name: "기각된 가설들",
    opening: "가장 그럴듯했지만 틀렸던 가설을 먼저 세우고 그것이 깨지는 지점에서 연다.",
    sections: [
      { heading: "가설 1과 그 반증", guidance: "무엇을 의심했고 어떤 관측이 그것을 죽였는가." },
      { heading: "가설 2와 그 반증", guidance: "같은 형식. 반증은 명령어 출력으로 제시한다." },
      { heading: "남은 하나", guidance: "기각되지 않은 설명과 그것을 확인한 방법." },
      { heading: "교훈", guidance: "다음에 같은 증상을 보면 무엇부터 볼 것인가." },
    ],
  },

  {
    id: "pattern-recurrence",
    kind: "pattern",
    name: "재발 간격으로 읽기",
    opening: "같은 원인이 몇 번, 며칠 간격으로 돌아왔는지를 수치로 먼저 던진다.",
    sections: [
      { heading: "몇 번이었나", guidance: "재발 횟수와 간격. 팩트 팩의 recurrence 수치만 쓴다." },
      { heading: "매번 달랐던 것", guidance: "겉으로 드러난 증상이 어떻게 달라 보였는지." },
      { heading: "매번 같았던 것", guidance: "공통 태그와 공통 에러 원문." },
      { heading: "무엇을 바꿔야 멈추나", guidance: "구조적 조치." },
    ],
  },
  {
    id: "pattern-shared-cause",
    kind: "pattern",
    name: "하나의 원인, 여러 얼굴",
    opening: "서로 무관해 보이던 사건 둘을 나란히 놓는 것으로 연다.",
    sections: [
      { heading: "무관해 보였던 사건들", guidance: "각 사건의 증상을 짧게. 날짜를 붙인다." },
      { heading: "겹치는 지점", guidance: "공통 태그·공통 스니펫으로 연결을 보인다." },
      { heading: "한 뿌리", guidance: "공통 원인." },
      { heading: "다음 얼굴은 어디서 나올까", guidance: "아직 안 터진 곳에 대한 추정은 추정이라고 밝힌다." },
    ],
  },
  {
    id: "pattern-cost",
    kind: "pattern",
    name: "누적 비용으로 읽기",
    opening: "이 패턴이 지금까지 잡아먹은 총량(건수·기간)을 먼저 적는다.",
    sections: [
      { heading: "누적", guidance: "건수·기간·심각도 분포." },
      { heading: "매번 든 비용", guidance: "각 사건에서 반복된 진단 절차." },
      { heading: "왜 아직 안 고쳤나", guidance: "구조적 장애물." },
      { heading: "고치는 값", guidance: "제안하는 조치와 그 범위." },
    ],
  },

  {
    id: "divergence-by-model",
    kind: "divergence-report",
    name: "모델별로 갈라 보기",
    opening: "어느 모델이 어느 축에서 몇 번 틀렸는지를 표 한 줄로 던진다.",
    sections: [
      { heading: "분포", guidance: "모델별·도구별 빈도. 팩트 팩의 집계 수치만." },
      { heading: "가장 잦은 축", guidance: "correction 유형이 가장 몰린 칸과 그 근거 토큰." },
      { heading: "실제 사례", guidance: "expected와 actual이 갈린 지점을 원문 근거로." },
      { heading: "환류", guidance: "CLAUDE.md·스킬로 되먹일 문장." },
    ],
  },
  {
    id: "divergence-by-correction",
    kind: "divergence-report",
    name: "무엇을 고쳤나로 갈라 보기",
    opening: "correction이 스펙을 고쳤는지 코드를 고쳤는지의 비율에서 시작한다.",
    sections: [
      { heading: "고친 대상의 분포", guidance: "correction 유형 분포와 분류 근거 토큰." },
      { heading: "스펙이 틀렸던 경우", guidance: "코드가 아니라 스펙을 고친 사례." },
      { heading: "코드가 틀렸던 경우", guidance: "반대 방향." },
      { heading: "분류되지 않은 것", guidance: "unclassified가 남은 이유. 숨기지 않는다." },
    ],
  },
  {
    id: "divergence-narrative",
    kind: "divergence-report",
    name: "한 건을 깊게, 나머지를 넓게",
    opening: "가장 비싼 이격 한 건의 expected/actual 대비로 연다.",
    sections: [
      { heading: "한 건", guidance: "가장 심각한 이격의 서사." },
      { heading: "같은 축의 나머지", guidance: "같은 모델·도구에서 나온 다른 건들." },
      { heading: "빈도", guidance: "집계 수치." },
      { heading: "무엇이 이 축을 닫나", guidance: "기계가 잡을 수 있는 형태로 제안." },
    ],
  },

  {
    id: "digest-timeline",
    kind: "digest",
    name: "시간순 다이제스트",
    opening: "이번 주 첫 기록의 날짜와 그 사건으로 연다.",
    sections: [
      { heading: "이번 주", guidance: "신규 기록을 시간순으로. 각 항목에 날짜와 태그." },
      { heading: "가장 무거웠던 것", guidance: "심각도 상위 사건 하나를 깊게." },
      { heading: "숫자", guidance: "건수·분포." },
    ],
  },
  {
    id: "digest-by-project",
    kind: "digest",
    name: "프로젝트별 다이제스트",
    opening: "가장 많이 기록된 프로젝트와 그 건수로 연다.",
    sections: [
      { heading: "프로젝트별", guidance: "프로젝트 분포와 각 프로젝트의 대표 사건." },
      { heading: "가로지르는 태그", guidance: "여러 프로젝트에 걸친 공통 태그." },
      { heading: "숫자", guidance: "건수·기간." },
    ],
  },
  {
    id: "digest-by-severity",
    kind: "digest",
    name: "심각도별 다이제스트",
    opening: "가장 심각한 등급의 건수를 먼저 적는다.",
    sections: [
      { heading: "무거운 것부터", guidance: "심각도 순으로. 각 항목에 에러 원문 한 줄." },
      { heading: "가벼웠지만 반복된 것", guidance: "낮은 심각도의 재발." },
      { heading: "숫자", guidance: "심각도 분포와 기간." },
    ],
  },
];

/** 유형별 골격 셋. 순서는 선언 순서이며 로테이션 인덱스의 기준이다. */
export function templatesFor(kind: ArticleKind): readonly ArticleTemplate[] {
  return ARTICLE_TEMPLATES.filter((template) => template.kind === kind);
}

/**
 * 골격 선택. **결정론이다** — 같은 소스 집합이면 언제나 같은 골격이 나온다.
 * 구분자로 NUL을 쓰는 이유는 T-029 `articleId`·T-030 `groupEvidence`와 같다.
 */
export function selectTemplate(
  kind: ArticleKind,
  sourceRecordIds: readonly string[],
): ArticleTemplate {
  const candidates = templatesFor(kind);
  const first = candidates[0];
  if (first === undefined) {
    throw new Error(`아티클 유형 ${kind}의 서사 템플릿이 없다 (specs/08 §4).`);
  }
  const index = fnv1a([...sourceRecordIds].sort().join(" ")) % candidates.length;
  return candidates[index] ?? first;
}

/**
 * 골격 + 팩트 팩 → 아웃라인 텍스트. 모델에게 "이 순서로 써라"라고 주는 지시이며,
 * 어느 마디에 어떤 팩트가 있는지를 함께 알려 준다 — 없는 팩트를 채우려는 유인을 줄인다.
 */
export function buildOutline(template: ArticleTemplate, facts: ArticleFacts): string {
  const lines = [
    `골격: ${template.name} (${template.id})`,
    `도입: ${template.opening}`,
    "마디:",
    ...template.sections.map(
      (section, index) => `  ${String(index + 1)}. ## ${section.heading} — ${section.guidance}`,
    ),
    "가용 팩트 요약:",
    `  레코드 ${String(facts.counts.records)}건 (사건 ${String(facts.counts.incidents)}, 이격 ${String(facts.counts.divergences)})`,
    `  기간 ${facts.period.firstAt.slice(0, 10)} ~ ${facts.period.lastAt.slice(0, 10)} (${String(facts.period.spanDays)}일)`,
    `  인용 후보 ${String(facts.citations.length)}건, 부가 신호 ${String(facts.signals.length)}건`,
    `  타임라인 ${String(facts.timeline.length)}점, 재발 ${String(facts.recurrence.occurrences)}회`,
  ];
  return lines.join("\n");
}

/** FNV-1a 32비트. 암호용이 아니라 **분산이 고른 결정론적 정수**가 필요할 뿐이다. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
