import { createServer, type Server, type Socket, connect as tcpConnect } from 'node:net'

const LOOPBACK_HOST = '127.0.0.1'
/** Lets the kernel pick a free port, so parallel runs never collide. */
const ANY_FREE_PORT = 0
const NOT_BOUND_MESSAGE = 'the proxy did not bind to a TCP port'

/**
 * A TCP relay that can stop answering without closing anything — the shape of
 * a Postgres that is paused, partitioned or wedged: the socket stays open, the
 * kernel keeps accepting bytes, and no reply ever comes back.
 *
 * Refusing the connection instead would be the easy failure — `pg` sees it at
 * once. This one only a client-side deadline can catch.
 *
 * While frozen, bytes in both directions are held rather than dropped, and new
 * connections are accepted but never relayed. `thaw` delivers what was held, as
 * a resumed server would.
 */
export interface FreezableTcpProxy {
  readonly port: number
  /** `url` with its host and port swapped for the proxy's. */
  proxiedUrl(url: string): string
  freeze(): void
  thaw(): void
  /** Relayed connections the client side has not closed yet. */
  openConnections(): number
  close(): Promise<void>
}

interface Relay {
  client: Socket
  upstream: Socket
  heldForUpstream: Buffer[]
  heldForClient: Buffer[]
}

export async function startFreezableTcpProxy(
  targetHost: string,
  targetPort: number,
): Promise<FreezableTcpProxy> {
  const relays = new Set<Relay>()
  let frozen = false

  function flush(relay: Relay): void {
    for (const chunk of relay.heldForUpstream.splice(0)) relay.upstream.write(chunk)
    for (const chunk of relay.heldForClient.splice(0)) relay.client.write(chunk)
  }

  const server: Server = createServer((client) => {
    const upstream = tcpConnect(targetPort, targetHost)
    const relay: Relay = { client, upstream, heldForUpstream: [], heldForClient: [] }
    relays.add(relay)

    client.on('data', (chunk) => {
      if (frozen) relay.heldForUpstream.push(chunk)
      else upstream.write(chunk)
    })
    upstream.on('data', (chunk) => {
      if (frozen) relay.heldForClient.push(chunk)
      else client.write(chunk)
    })

    const teardown = () => {
      relays.delete(relay)
      client.destroy()
      upstream.destroy()
    }
    client.on('close', teardown)
    upstream.on('close', teardown)
    client.on('error', teardown)
    upstream.on('error', teardown)
  })

  await new Promise<void>((resolve) =>
    server.listen(ANY_FREE_PORT, LOOPBACK_HOST, resolve),
  )
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error(NOT_BOUND_MESSAGE)
  }
  const { port } = address

  return {
    port,
    proxiedUrl(url) {
      const proxied = new URL(url)
      proxied.hostname = LOOPBACK_HOST
      proxied.port = String(port)
      return proxied.toString()
    },
    freeze() {
      frozen = true
    },
    thaw() {
      frozen = false
      for (const relay of relays) flush(relay)
    },
    openConnections() {
      return relays.size
    },
    async close() {
      for (const relay of relays) {
        relay.client.destroy()
        relay.upstream.destroy()
      }
      relays.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
