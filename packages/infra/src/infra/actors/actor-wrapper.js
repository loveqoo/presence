import fp from '@presence/core/lib/fun-fp.js'

const { Actor } = fp

class ActorWrapper {
  constructor(init, handle) {
    this.actor = Actor({ init, handle })
  }
  send(msg) { return this.actor.send(msg) }
  subscribe(fn) { return this.actor.subscribe(fn) }
}

export { ActorWrapper }
