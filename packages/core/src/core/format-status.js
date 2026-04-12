import fp from '../lib/fun-fp.js'
import { RESULT } from './policies.js'

const { Reader } = fp

const LAST_LABEL = Object.freeze({
  [RESULT.SUCCESS]: RESULT.SUCCESS,
  [RESULT.FAILURE]: RESULT.FAILURE,
})

// translate: i18n t() 함수. 없으면 영문 기본값 사용 (서버 경로)
export const formatStatusR = Reader.asks(({ translate }) =>
  ({ status, turn, memoryCount, lastTurnTag }) => {
    const last = LAST_LABEL[lastTurnTag] || 'none'
    if (translate) {
      return translate('status_cmd.label', {
        status: translate(`status_cmd.status_${status}`) || status,
        turn,
        mem: memoryCount,
        last: translate(`status_cmd.last_${last}`),
      })
    }
    return `status: ${status} | turn: ${turn} | mem: ${memoryCount} | last: ${last}`
  },
)
