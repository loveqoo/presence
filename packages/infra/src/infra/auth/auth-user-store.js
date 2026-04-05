import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { Config } from '../config.js'

// =============================================================================
// UserStore: 사용자 CRUD + refreshSessions 관리
// 파일: ~/.presence/users.json
// =============================================================================

const MIN_PASSWORD_LENGTH = 8
const BCRYPT_ROUNDS = 12

const UserSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  passwordHash: z.string(),
  roles: z.array(z.string()).default(['user']),
  tokenVersion: z.number().int().default(0),
  refreshSessions: z.array(z.string()).default([]),
  createdAt: z.string(),
  mustChangePassword: z.boolean().optional(),
})

const UserStoreFileSchema = z.object({
  users: z.array(UserSchema).default([]),
})

/**
 * Returns the filesystem path of the users file.
 * @param {string} [basePath] - Override for ~/.presence directory
 * @returns {string}
 */
const usersFilePath = (basePath) => {
  const dir = basePath || process.env.PRESENCE_DIR || Config.presenceDir()
  return join(dir, 'users.json')
}

const readStore = (filePath) => {
  if (!existsSync(filePath)) return null
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  const result = UserStoreFileSchema.safeParse(raw)
  return result.success ? result.data : { users: [] }
}

const writeStore = (filePath, data) => {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * Creates a UserStore for managing users and refresh sessions.
 * Persists data to ~/.presence/users.json.
 * @param {{ basePath?: string }} [opts]
 * @returns {{ findUser, listUsers, addUser, removeUser, changePassword, verifyPassword, addRefreshSession, removeRefreshSession, hasRefreshSession, revokeAllRefreshSessions, hasUsers, exists, filePath }}
 */

const createUserStore = ({ basePath } = {}) => {
  const filePath = usersFilePath(basePath)

  const load = () => readStore(filePath) || { users: [] }
  const save = (data) => writeStore(filePath, data)

  const findUser = (username) => {
    const store = load()
    const user = store.users.find(u => u.username === username) || null
    if (!user) return null
    // Backward compatibility: old records without mustChangePassword default to false
    if (user.mustChangePassword === undefined) user.mustChangePassword = false
    return user
  }

  const listUsers = () => {
    const store = load()
    return store.users.map(({ username, roles, createdAt }) => ({ username, roles, createdAt }))
  }

  const addUser = async (username, password) => {
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
      throw new Error('Username must be 1-64 characters: letters, numbers, _ or -')
    }
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }

    const store = load()
    if (store.users.some(u => u.username === username)) {
      throw new Error(`User already exists: ${username}`)
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const user = {
      username,
      passwordHash,
      roles: store.users.length === 0 ? ['admin'] : ['user'],
      tokenVersion: 0,
      refreshSessions: [],
      createdAt: new Date().toISOString(),
      mustChangePassword: true,
    }

    store.users.push(user)
    save(store)
    return { username: user.username, roles: user.roles }
  }

  const removeUser = (username) => {
    const store = load()
    const idx = store.users.findIndex(u => u.username === username)
    if (idx === -1) throw new Error(`User not found: ${username}`)
    store.users.splice(idx, 1)
    save(store)
  }

  const changePassword = async (username, newPassword) => {
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }

    const store = load()
    const user = store.users.find(u => u.username === username)
    if (!user) throw new Error(`User not found: ${username}`)

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    user.tokenVersion += 1
    user.refreshSessions = [] // 모든 세션 무효화
    user.mustChangePassword = false
    save(store)
  }

  const verifyPassword = async (username, password) => {
    const user = findUser(username)
    if (!user) return false
    return bcrypt.compare(password, user.passwordHash)
  }

  // --- Refresh session 관리 ---

  const addRefreshSession = (username, jti) => {
    const store = load()
    const user = store.users.find(u => u.username === username)
    if (!user) return
    user.refreshSessions.push(jti)
    save(store)
  }

  const removeRefreshSession = (username, jti) => {
    const store = load()
    const user = store.users.find(u => u.username === username)
    if (!user) return false
    const idx = user.refreshSessions.indexOf(jti)
    if (idx === -1) return false
    user.refreshSessions.splice(idx, 1)
    save(store)
    return true
  }

  const hasRefreshSession = (username, jti) => {
    const user = findUser(username)
    if (!user) return false
    return user.refreshSessions.includes(jti)
  }

  // 폐기된 jti로 갱신 시도 → 탈취 감지: 모든 세션 삭제
  const revokeAllRefreshSessions = (username) => {
    const store = load()
    const user = store.users.find(u => u.username === username)
    if (!user) return
    user.refreshSessions = []
    save(store)
  }

  const hasUsers = () => {
    const store = readStore(filePath)
    return store !== null && store.users.length > 0
  }

  const exists = () => existsSync(filePath)

  return {
    findUser,
    listUsers,
    addUser,
    removeUser,
    changePassword,
    verifyPassword,
    addRefreshSession,
    removeRefreshSession,
    hasRefreshSession,
    revokeAllRefreshSessions,
    hasUsers,
    exists,
    filePath,
  }
}

export { createUserStore, MIN_PASSWORD_LENGTH, UserStoreFileSchema }
