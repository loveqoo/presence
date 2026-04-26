# audit log rotation 상태를 운영자가 인지할 수 없음 (FP-70)

**영역**: infra (서버 운영 가시성)
**심각도**: low
**상태**: open
**관련 코드**: `packages/infra/src/infra/authz/cedar/audit.js`, `packages/infra/src/infra/authz/cedar/index.js`

> **FP-70** 으로 REGISTRY.md 등록 완료 (2026-04-26).

## 시나리오

운영자(admin)가 수개월 운영 후 디스크 점검을 한다. `~/.presence/logs/` 를 열면 `authz-audit.log`, `authz-audit.log.1.gz`, `authz-audit.log.2.gz` 등이 있다. 운영자는 다음을 알고 싶다:

- 지금 로그가 얼마나 찼는가? (곧 또 rotation이 일어나는가?)
- 총 몇 개의 백업이 쌓였는가?
- 지난주 특정 날에 무슨 권한 결정이 있었는가? (`.gz` 파일을 어떻게 열면 되는가?)

## 현재 동작

### 1. rotation 발생 시 알림 없음

`audit.js:rotateIfNeeded` 는 `statSync` size 체크 → `cascadeBackups` → `archiveCurrent` 를 완전히 조용하게 수행한다. `console.log`, 서버 로그(`logger`), 또는 별도 server.log 출력이 전혀 없다.

```
// audit.js:63-68
const rotateIfNeeded = (logPath, maxBytes, maxBackups) => {
  if (!existsSync(logPath)) return
  if (statSync(logPath).size < maxBytes) return
  cascadeBackups(logPath, maxBackups)
  archiveCurrent(logPath)
  // ← 아무 로그 없음
}
```

`bootCedarSubsystem` / `server/index.js` 부팅 경로에도 Cedar audit 관련 상태 로그 없음.

### 2. 상태 조회 경로 없음

- TUI 슬래시 커맨드 (`/status`, `/statusline`, `/mcp` 등): audit log 상태 노출 없음.
- `npm run user -- ...` CLI: audit 상태 조회 서브커맨드 없음.
- `createAuditWriter` 가 export 하는 공개 API: `append` 함수 하나만. `getStatus()` / `currentSize()` 없음.

### 3. `.gz` 백업 열람 안내 없음

- `cedar-infra.md §1.6` 에 "분석은 `jq` 등 외부 도구" 언급이 있으나, 이는 설계 문서이며 admin이 런타임에서 참조하는 경로가 아니다.
- `.gz` 압축 백업을 열람하려면 `gunzip authz-audit.log.1.gz && cat authz-audit.log.1 | jq` 를 알아야 하지만, TUI/CLI/서버 어디에서도 이 안내를 제공하지 않는다.

## 마찰 포인트

| 포인트 | 설명 |
|--------|------|
| rotation 무음 처리 | 10MB 마다 rotation이 자동 발생하지만 서버 로그 어디에도 기록되지 않아, 운영자가 rotation 이력을 파악할 수 없다 |
| 현재 로그 size 조회 불가 | 운영자가 디스크 여유를 확인하거나 "곧 rotation?" 을 예측할 방법이 없다 |
| 백업 열람 방법 불명 | `.gz` 확장자만 보고 내용 확인 방법을 알기 어렵다. 특히 권한 감사 목적(보안 이벤트 추적)으로 필요한 시점에 열람이 지연될 수 있다 |

## 제안

### 최우선 (즉시 적용 가능)

**server.log 에 rotation 발생 기록**

rotation 이 발생하면 서버가 이미 logger 를 보유하고 있으므로, `bootCedarSubsystem` 에서 `auditWriter` 가 logger 를 받거나, `rotateIfNeeded` 에 선택적 콜백을 두어 rotation 발생 시 `console.log('[cedar-audit] rotated → .1.gz')` 수준의 한 줄 로그를 남기면 된다. 운영자는 서버 로그에서 `grep 'cedar-audit'` 로 이력을 조회할 수 있다.

형식 제안:
```
[cedar-audit] rotation: authz-audit.log → .1.gz (size: 10.2 MB, backups: 1/5)
```

### 중간 (문서/안내 추가)

**`/status` 커맨드 또는 admin 전용 커맨드에 audit log 상태 라인 추가**

예시:
```
감사 로그: 8.3 MB / 10 MB (백업 2개)
```

이는 `/status` 의 기존 포맷에 한 줄 추가 수준이며, admin role 로그인 상태에서만 표시해도 된다.

**`.gz` 열람 안내**

`/help` 또는 admin 관련 안내 출력에 단 한 줄:
```
감사 로그 백업(.gz)은 gunzip으로 압축을 풀어 jq로 조회하세요.
```

## 근거

운영자는 다음 두 가지 이유로 audit log 접근이 필요하다:

1. **보안 감사**: 특정 날짜의 `create_agent` 결정이 누구에 의해 허용/거부되었는지 추적
2. **디스크 관리**: rotation 빈도와 현재 사용량을 파악해 백업 수(`maxBackups`)를 적절히 설정

현재 구현에서 두 가지 모두 운영자가 스스로 `ls -lh ~/.presence/logs/` 를 실행해야만 가능하다. rotation 발생 시 서버 로그에 한 줄 기록하는 것만으로도 1번 문제의 타임라인 재구성이 가능해진다.

심각도가 low인 이유: KG-25 는 이미 resolved 되었고, 로그는 자동으로 올바르게 관리된다. 이 FP 는 "작동은 하지만 운영자가 알 방법이 없다"는 가시성 부재 문제로, 서비스 중단이나 데이터 손실을 유발하지 않는다.
