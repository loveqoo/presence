import winston from 'winston'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const LOG_DIR = join(homedir(), '.presence', 'logs')

const createLogger = ({ level = 'info', logDir = LOG_DIR } = {}) => {
  mkdirSync(logDir, { recursive: true })

  const logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.File({
        filename: join(logDir, 'agent.log'),
        maxsize: 5 * 1024 * 1024, // 5MB
        maxFiles: 3,
      })
    ],
  })

  const setLevel = (newLevel) => {
    logger.level = newLevel
  }

  return { logger, setLevel }
}

export { createLogger }
