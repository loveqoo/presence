// CLI 공통 유틸 — flag 검증 등.

export const requireFlag = (flags, name) => {
  if (!flags[name]) {
    console.error(`--${name} is required`)
    process.exit(1)
  }
  return flags[name]
}
