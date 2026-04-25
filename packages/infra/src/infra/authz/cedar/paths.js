// Cedar 정적 자산 경로 — 인프라 패키지 안에서만 위치를 알고 있다.
// import.meta.url 기반 절대 경로 해석 → 호출자 (server) 는 이 export 만 사용,
// `policies/` 디렉토리나 `schema.cedarschema` 를 직접 참조하지 않는다.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))

export const POLICIES_DIR = join(here, 'policies')
export const SCHEMA_PATH = join(here, 'schema.cedarschema')
