// =============================================================================
// ESLint flat config — 복잡도/품질 게이트 (자체 scripts/complexity.js 대체).
//
// 적용 범위: packages/*/src/**/*.js (테스트 / fun-fp.js / 외부 자료 제외).
// pre-commit hook (.claude/hooks/check-complexity.sh) 이 staged .js 파일에 대해
// `eslint --max-warnings 0` 실행. error 임계치 초과 시 커밋 차단.
//
// 임계치 산정:
//   max-lines (LOC): 300
//   max-params:        5   (5 초과 → Reader DI 또는 옵션 객체 — fp-monad.md / refactor.md 통일)
//                          객체 destructuring `({ a, b, c, d, e, f })` 는 1 param 으로 카운트
//                          되므로 옵션 객체 패턴은 자연스럽게 우회.
//   max-depth:         6
//   complexity (CC):  70  (App.js 가 62 — 자체 도구의 48 보다 ESLint 가 엄격, 마진 +8)
//   sonarjs/cognitive-complexity: 50  (App.js 가 41, 마진 +9)
//
// 주의: 자체 complexity.js 의 cyclomatic 측정과 ESLint 의 측정이 약간 다름.
// 자체는 분기점 + 1, ESLint 는 함수 진입 + 분기 + 논리 연산자 등 더 포괄. 임계치를
// 산식에 맞춰 조정.
// =============================================================================

import js from '@eslint/js'
import sonarjs from 'eslint-plugin-sonarjs'
import globals from 'globals'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/test/**',
      '**/tests/**',
      '**/*.test.js',
      'packages/core/src/lib/fun-fp.js',
      'scripts/**',
      '.claude/**',
      'docs/**',
      'apps/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['packages/*/src/**/*.js'],
    linterOptions: {
      // 자체 도구 잔재의 // eslint-disable-* 주석 무시
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { sonarjs },
    rules: {
      // 복잡도 게이트 — 자체 complexity.js 대체
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-params': ['error', 5],
      'max-depth': ['error', 6],
      'complexity': ['error', 70],
      'sonarjs/cognitive-complexity': ['error', 50],

      // 자체 도구 잔재 (ESLint 도입 전의 // eslint-disable-* 주석) 무시
      'no-unused-disable': 'off',

      // 다른 모든 일반 rules 는 비활성 (이번 도입은 복잡도 게이트만 목적).
      // 필요 시 후속 PR 에서 점진 활성화.
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-cond-assign': 'off',
      'no-control-regex': 'off',
      'no-prototype-builtins': 'off',
      'no-undef': 'off',
      'no-useless-escape': 'off',
      'no-redeclare': 'off',
      'no-self-assign': 'off',
      'no-fallthrough': 'off',
      'no-empty-pattern': 'off',
      'no-constant-condition': 'off',
      'no-irregular-whitespace': 'off',
      'no-async-promise-executor': 'off',
      'no-misleading-character-class': 'off',
      'no-sparse-arrays': 'off',
    },
  },
]
