import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { S3Storage } from '../src/index.js'

const BUCKET = 'studio'

interface Stored {
  bytes: Buffer
  contentType: string | undefined
}

interface FakeS3 {
  url: string
  /** Exposed so tests can assert on what actually went over the wire. */
  objects: Map<string, Stored>
  stop(): Promise<void>
}

const noSuchKey = (key: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>${key}</Key></Error>`

const INTERNAL_ERROR = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>injected fault</Message></Error>'

/**
 * Stands in for an S3-compatible service. It implements the three verbs `S3Storage`
 * uses and answers a missing key the way the API documents, but it never inspects the
 * `Authorization` header. So this covers the client side of the contract — request
 * shaping, path-style addressing, content type, length extraction, and telling absence
 * apart from a fault — and says nothing about whether a real endpoint would accept our
 * signature. There is no MinIO or container runtime available to check that.
 */
function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Stored>()

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const key = new URL(request.url ?? '/', 'http://localhost').pathname.slice(`/${BUCKET}/`.length)

    // Anything under /fault/ answers 500, so a test can tell a swallowed outage apart
    // from a genuinely absent object.
    if (key.includes('/fault/')) {
      response.writeHead(500, { 'content-type': 'application/xml' }).end(INTERNAL_ERROR)
      return
    }

    const stored = objects.get(key)

    if (request.method === 'PUT') {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        objects.set(key, { bytes: Buffer.concat(chunks), contentType: request.headers['content-type'] })
        response.writeHead(200, { etag: '"fake-etag"' }).end()
      })
      return
    }

    if (request.method === 'HEAD') {
      if (!stored) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, headers(stored)).end()
      return
    }

    if (request.method === 'GET') {
      if (!stored) {
        response.writeHead(404, { 'content-type': 'application/xml' }).end(noSuchKey(key))
        return
      }
      response.writeHead(200, headers(stored)).end(stored.bytes)
      return
    }

    response.writeHead(405).end()
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        objects,
        stop: () => new Promise<void>(done => {
          // The SDK keeps sockets alive; closing the listener alone would hang here.
          server.closeAllConnections()
          server.close(() => done())
        }),
      })
    })
  })
}

function headers(stored: Stored): Record<string, string> {
  return {
    'content-length': String(stored.bytes.byteLength),
    'content-type': stored.contentType ?? 'application/octet-stream',
  }
}

describe('s3 storage', () => {
  let fake: FakeS3
  let storage: S3Storage

  beforeAll(async () => {
    fake = await startFakeS3()
    storage = new S3Storage({
      endpoint: fake.url,
      bucket: BUCKET,
      region: 'us-east-1',
      accessKey: 'studio',
      secretKey: 'studio-password',
    })
  })

  afterAll(async () => {
    await storage.close()
    await fake.stop()
  })

  it('round-trips bytes with their content type and a locally computed checksum', async () => {
    const key = 'org-1/proj-1/ep-1/VIDEO/task-1/v1.mp4'
    const stored = await storage.put(key, new Uint8Array([1, 2, 3, 4, 5]), 'video/mp4')

    expect(stored.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.sizeBytes).toBe(5)
    expect(stored.mimeType).toBe('video/mp4')
    expect(fake.objects.get(key)?.contentType).toBe('video/mp4')
    expect(await storage.exists(key)).toBe(true)
    expect([...(await storage.read(key))]).toEqual([1, 2, 3, 4, 5])
  })

  it('puts the caller\'s bytes rather than transfer framing', async () => {
    // The SDK signs uploads as aws-chunked when it attaches a checksum, which replaces
    // the payload with framed chunks. This is the assertion that catches it.
    const key = 'org-1/proj-1/ep-1/FIRST_FRAME/task-2/v1.png'
    const payload = Buffer.from('89504e470d0a1a0a', 'hex')
    await storage.put(key, new Uint8Array(payload), 'image/png')
    expect(fake.objects.get(key)?.bytes.equals(payload)).toBe(true)
  })

  it('opens an object as a stream carrying the length the service reported', async () => {
    const key = 'org-1/proj-1/ep-1/VIDEO/task-3/v1.mp4'
    await storage.put(key, new Uint8Array([7, 7, 7]), 'video/mp4')

    const opened = await storage.open(key)
    expect(opened).not.toBeNull()
    expect(opened!.sizeBytes).toBe(3)

    const chunks: Buffer[] = []
    for await (const chunk of opened!.body) chunks.push(chunk as Buffer)
    expect([...Buffer.concat(chunks)]).toEqual([7, 7, 7])
  })

  it('reports an absent object as absent rather than as a failure', async () => {
    const key = 'org-1/never/stored/v1.png'
    expect(await storage.open(key)).toBeNull()
    expect(await storage.exists(key)).toBe(false)
  })

  it('propagates a service fault instead of reporting the object absent', async () => {
    // Answering a 500 as "not found" would turn an outage into a silent 404 and hide
    // the fact that stored media is unreachable.
    const key = 'org-1/fault/v1.mp4'
    await expect(storage.open(key)).rejects.toThrow()
    await expect(storage.exists(key)).rejects.toThrow()
  })
})
