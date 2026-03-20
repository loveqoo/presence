// Bracketed Paste Mode
// 터미널이 붙여넣기를 \e[200~ ... \e[201~ 으로 감싸줌
// 이를 감지해서 여러 줄 입력을 하나로 합침

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

class InputHandler {
  constructor({ onLine, onPaste } = {}) {
    this._onLine = onLine || (() => {})
    this._onPaste = onPaste || onLine || (() => {})
    this._buffer = ''
    this._pasting = false
    this._pasteBuffer = ''
  }

  // stdin의 raw 데이터를 받아 처리
  feed(chunk) {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')

    for (let i = 0; i < str.length; i++) {
      // Paste start 시퀀스 감지
      if (str.slice(i, i + PASTE_START.length) === PASTE_START) {
        this._pasting = true
        this._pasteBuffer = ''
        i += PASTE_START.length - 1
        continue
      }

      // Paste end 시퀀스 감지
      if (this._pasting && str.slice(i, i + PASTE_END.length) === PASTE_END) {
        this._pasting = false
        this._onPaste(this._pasteBuffer)
        this._pasteBuffer = ''
        i += PASTE_END.length - 1
        continue
      }

      if (this._pasting) {
        this._pasteBuffer += str[i]
      } else {
        if (str[i] === '\r' || str[i] === '\n') {
          if (this._buffer.length > 0) {
            this._onLine(this._buffer)
            this._buffer = ''
          }
        } else {
          this._buffer += str[i]
        }
      }
    }
  }

  // 남은 버퍼 플러시
  flush() {
    if (this._buffer.length > 0) {
      this._onLine(this._buffer)
      this._buffer = ''
    }
    if (this._pasting && this._pasteBuffer.length > 0) {
      this._onPaste(this._pasteBuffer)
      this._pasteBuffer = ''
      this._pasting = false
    }
  }

  // Bracketed Paste Mode 활성화 이스케이프 시퀀스
  static enableSequence() { return '\x1b[?2004h' }
  static disableSequence() { return '\x1b[?2004l' }

  // 붙여넣기 요약 텍스트 생성
  static summarizePaste(text) {
    const lines = text.split('\n').length
    const chars = text.length
    return `[붙여넣기: ${lines}줄, ${chars}자]`
  }
}

export { InputHandler, PASTE_START, PASTE_END }
