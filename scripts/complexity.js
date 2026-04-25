#!/usr/bin/env node

// =============================================================================
// complexity.js — AST 기반 코드 복잡도 분석기
//
// 사용법:
//   node scripts/complexity.js                    전체 리포트 (packages/*/src/**/*.js)
//   node scripts/complexity.js --check f1 f2 ...  임계치 검사 (exit 1 on violation)
//   node scripts/complexity.js --json              JSON 출력
//   node scripts/complexity.js src/foo.js          특정 파일만 리포트
// =============================================================================

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { resolve, relative, join, extname } from 'path'
import { parse } from 'acorn'
import * as walk from 'acorn-walk'

// --- 임계치 (hook 검사용) ---

const THRESHOLDS = Object.freeze({
  loc: 300,
  functions: 25,
  maxParams: 5,
  maxDepth: 6,
  cyclomatic: 50,
  imports: 20,
})

// --- 가중치 (Score 계산용) ---

const WEIGHTS = Object.freeze({
  loc: 0.5,
  functions: 1,
  maxParams: 3,
  maxDepth: 5,
  cyclomatic: 2,
  imports: 0.5,
})

// --- AST 분석 ---

const LOGICAL_OPS = new Set(['&&', '||', '??'])

// 체이닝 콜백으로 간주할 메서드 이름 — Fn 카운트에서 제외
const CHAINING_METHODS = new Set([
  'chain', 'map', 'flatMap', 'fold', 'reduce', 'then', 'catch', 'finally',
  'filter', 'find', 'some', 'every', 'forEach',
])

const NESTING_TYPES = new Set([
  'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'SwitchStatement',
  'TryStatement', 'ArrowFunctionExpression', 'FunctionExpression',
  'FunctionDeclaration',
])

function analyze(code, filePath) {
  let ast
  try {
    ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  } catch (e) {
    return { file: filePath, error: e.message }
  }

  // LOC (빈 줄, 주석 전용 줄 제외)
  const lines = code.split('\n')
  const loc = lines.filter(l => {
    const t = l.trim()
    return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && t !== '/*' && t !== '*/'
  }).length

  // Import 수
  let imports = 0

  // 함수 수 + 최대 파라미터 수
  let functions = 0
  let maxParams = 0

  // Cyclomatic complexity (분기 수 + 1)
  let branches = 0

  // 최대 중첩 깊이 (AST 구조 기반)
  let maxDepth = 0

  function walkDepth(node, depth) {
    if (NESTING_TYPES.has(node.type)) {
      depth++
      if (depth > maxDepth) maxDepth = depth
    }

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (child && typeof child === 'object') {
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item.type === 'string') walkDepth(item, depth)
          }
        } else if (typeof child.type === 'string') {
          walkDepth(child, depth)
        }
      }
    }
  }

  // 체이닝 콜백인지 판별: 부모가 CallExpression이고 callee가 체이닝 메서드
  const isChainingCallback = (ancestors) => {
    if (ancestors.length < 2) return false
    const parent = ancestors[ancestors.length - 2]
    if (parent.type !== 'CallExpression') return false
    const callee = parent.callee
    // obj.method() 형태
    if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
      return CHAINING_METHODS.has(callee.property.name)
    }
    return false
  }

  // class method 의 value (FunctionExpression) — MethodDefinition 핸들러가
  // 이미 method 자체를 카운트하므로 inner FunctionExpression 은 중복 카운트.
  const isClassMethodValue = (ancestors) => {
    if (ancestors.length < 2) return false
    return ancestors[ancestors.length - 2].type === 'MethodDefinition'
  }

  walk.ancestor(ast, {
    ImportDeclaration() { imports++ },

    FunctionDeclaration(node) {
      functions++
      if (node.params.length > maxParams) maxParams = node.params.length
    },
    FunctionExpression(node, ancestors) {
      if (!isChainingCallback(ancestors) && !isClassMethodValue(ancestors)) functions++
      if (node.params.length > maxParams) maxParams = node.params.length
    },
    ArrowFunctionExpression(node, ancestors) {
      if (!isChainingCallback(ancestors)) functions++
      if (node.params.length > maxParams) maxParams = node.params.length
    },
    MethodDefinition(node) {
      functions++
      const fn = node.value
      if (fn && fn.params && fn.params.length > maxParams) maxParams = fn.params.length
    },

    // Cyclomatic: 분기점
    IfStatement() { branches++ },
    ConditionalExpression() { branches++ },
    SwitchCase() { branches++ },
    ForStatement() { branches++ },
    ForInStatement() { branches++ },
    ForOfStatement() { branches++ },
    WhileStatement() { branches++ },
    DoWhileStatement() { branches++ },
    CatchClause() { branches++ },
    LogicalExpression(node) {
      if (LOGICAL_OPS.has(node.operator)) branches++
    },
  })

  // Destructuring 파라미터: 프로퍼티 수 카운팅
  walk.simple(ast, {
    FunctionDeclaration(node) { countDestructuredParams(node) },
    FunctionExpression(node) { countDestructuredParams(node) },
    ArrowFunctionExpression(node) { countDestructuredParams(node) },
  })

  function countDestructuredParams(node) {
    for (const param of node.params) {
      if (param.type === 'ObjectPattern' && param.properties.length > maxParams) {
        maxParams = param.properties.length
      }
    }
  }

  const cyclomatic = branches + 1

  // 중첩 깊이 계산
  walkDepth(ast, 0)

  // Score 계산
  const score = Math.round(
    loc * WEIGHTS.loc +
    functions * WEIGHTS.functions +
    maxParams * WEIGHTS.maxParams +
    maxDepth * WEIGHTS.maxDepth +
    cyclomatic * WEIGHTS.cyclomatic +
    imports * WEIGHTS.imports
  )

  return { file: filePath, loc, functions, maxParams, maxDepth, cyclomatic, imports, score }
}

// --- 파일 수집 ---

const IGNORE_NAMES = new Set(['node_modules', '.git'])
const IGNORE_FILES = new Set(['fun-fp.js'])

function walkDir(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_NAMES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkDir(full, acc)
    } else if (extname(entry.name) === '.js' && !IGNORE_FILES.has(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

function collectFiles(rootDir) {
  const packagesDir = join(rootDir, 'packages')
  if (!existsSync(packagesDir)) return []
  const files = []
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const srcDir = join(packagesDir, pkg.name, 'src')
    if (existsSync(srcDir)) files.push(...walkDir(srcDir))
  }
  return files.sort()
}

// --- 출력 ---

function printTable(results) {
  const sorted = results
    .filter(r => !r.error)
    .sort((a, b) => b.score - a.score)

  // 헤더
  const cols = ['File', 'LOC', 'Fn', 'Params', 'Depth', 'CC', 'Imports', 'Score']
  const widths = [50, 5, 4, 6, 5, 4, 7, 6]

  const pad = (s, w) => String(s).padStart(w)
  const padL = (s, w) => String(s).padEnd(w)

  const header = cols.map((c, i) => i === 0 ? padL(c, widths[i]) : pad(c, widths[i])).join(' │ ')
  const sep = widths.map(w => '─'.repeat(w)).join('─┼─')

  console.log(header)
  console.log(sep)

  for (const r of sorted) {
    const row = [
      padL(truncPath(r.file), widths[0]),
      pad(r.loc, widths[1]),
      pad(r.functions, widths[2]),
      pad(r.maxParams, widths[3]),
      pad(r.maxDepth, widths[4]),
      pad(r.cyclomatic, widths[5]),
      pad(r.imports, widths[6]),
      pad(r.score, widths[7]),
    ].join(' │ ')
    console.log(row)
  }

  console.log(`\n총 ${sorted.length}개 파일`)

  const errors = results.filter(r => r.error)
  if (errors.length > 0) {
    console.log(`\n파싱 실패 ${errors.length}개:`)
    for (const e of errors) console.log(`  ${e.file}: ${e.error}`)
  }
}

function truncPath(filePath) {
  const rel = filePath.includes('packages/')
    ? filePath.substring(filePath.indexOf('packages/'))
    : filePath
  return rel.length > 50 ? '…' + rel.slice(-49) : rel
}

function printJson(results) {
  const sorted = results.filter(r => !r.error).sort((a, b) => b.score - a.score)
  console.log(JSON.stringify(sorted, null, 2))
}

// --- 체크 모드 ---

function checkFiles(results) {
  const violations = []
  for (const r of results) {
    if (r.error) continue
    const exceeded = []
    if (r.loc > THRESHOLDS.loc) exceeded.push(`LOC=${r.loc}(>${THRESHOLDS.loc})`)
    if (r.functions > THRESHOLDS.functions) exceeded.push(`Fn=${r.functions}(>${THRESHOLDS.functions})`)
    if (r.maxParams > THRESHOLDS.maxParams) exceeded.push(`Params=${r.maxParams}(>${THRESHOLDS.maxParams})`)
    if (r.maxDepth > THRESHOLDS.maxDepth) exceeded.push(`Depth=${r.maxDepth}(>${THRESHOLDS.maxDepth})`)
    if (r.cyclomatic > THRESHOLDS.cyclomatic) exceeded.push(`CC=${r.cyclomatic}(>${THRESHOLDS.cyclomatic})`)
    if (r.imports > THRESHOLDS.imports) exceeded.push(`Imports=${r.imports}(>${THRESHOLDS.imports})`)
    if (exceeded.length > 0) {
      violations.push({ file: r.file, exceeded })
    }
  }
  return violations
}

// --- main ---

function main() {
  const args = process.argv.slice(2)
  const isCheck = args.includes('--check')
  const isJson = args.includes('--json')
  const files = args.filter(a => !a.startsWith('--'))

  const rootDir = resolve(import.meta.dirname, '..')

  let targets
  if (files.length > 0) {
    targets = files.map(f => resolve(f))
  } else {
    targets = collectFiles(rootDir)
  }

  const results = targets
    .filter(f => existsSync(f))
    .map(f => analyze(readFileSync(f, 'utf8'), relative(rootDir, f)))

  if (isCheck) {
    const violations = checkFiles(results)
    if (violations.length === 0) {
      process.exit(0)
    }
    console.error('복잡도 임계치 초과:')
    console.error(`  기준: LOC≤${THRESHOLDS.loc} Fn≤${THRESHOLDS.functions} Params≤${THRESHOLDS.maxParams} Depth≤${THRESHOLDS.maxDepth} CC≤${THRESHOLDS.cyclomatic} Imports≤${THRESHOLDS.imports}`)
    for (const v of violations) {
      console.error(`  ${v.file}: ${v.exceeded.join(', ')}`)
    }
    process.exit(1)
  }

  if (isJson) {
    printJson(results)
  } else {
    printTable(results)
  }
}

main()
