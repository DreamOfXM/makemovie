/**
 * A provider base URL is typed by a user and then called by the worker with a
 * decrypted API key in the header, so the address is worth saving only if it is a
 * real endpoint rather than a route into the host's own network.
 *
 * This checks the literal address. A public hostname that resolves to an internal
 * address — or resolves differently on the second lookup — is a different attack and
 * is caught where the connection is actually made, not here.
 */
export interface ProviderUrlCheck {
  ok: boolean
  /** Normalised enough to store: trimmed, exactly as typed. */
  url?: string
  error?: string
}

const PRIVATE_HINT = 'set STUDIO_ALLOW_PRIVATE_PROVIDER_URLS=1 if the model gateway is self-hosted on this network'

export function checkProviderBaseUrl(raw: string, options: { allowPrivate: boolean }): ProviderUrlCheck {
  const url = raw.trim()
  if (!url) return { ok: false, error: 'baseUrl cannot be empty' }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'baseUrl must be an absolute http(s) URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `baseUrl must be an http(s) URL, got "${parsed.protocol.replace(':', '')}"` }
  }
  // Credentials in the URL would be logged by whoever reads the connection back, and
  // every provider authenticates with a header instead.
  if (parsed.username || parsed.password) return { ok: false, error: 'baseUrl must not embed credentials' }

  const host = parsed.hostname
  if (!host) return { ok: false, error: 'baseUrl must name a host' }
  if (!options.allowPrivate && isPrivateHost(host)) {
    return { ok: false, error: `baseUrl points at a private, loopback or link-local address; ${PRIVATE_HINT}` }
  }
  return { ok: true, url }
}

function isPrivateHost(host: string): boolean {
  const name = host.toLowerCase()
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')) return true

  const bare = name.startsWith('[') ? name.slice(1, -1) : name
  const v4 = ipv4Bytes(bare)
  if (v4) return isPrivateIpv4(v4)
  if (!name.startsWith('[')) return false

  const v6 = ipv6Bytes(bare)
  if (!v6) return false
  const mapped = ipv4MappedInIpv6(v6)
  if (mapped) return isPrivateIpv4(mapped)
  return isPrivateIpv6(v6)
}

function isPrivateIpv4([a, b]: number[]): boolean {
  if (a === 0) return true // "this host" — 0.0.0.0 and 0.x reach the machine itself
  if (a === 127) return true // loopback
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true // link-local, and the cloud metadata address
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  return false
}

function isPrivateIpv6(bytes: number[]): boolean {
  if (bytes.every(byte => byte === 0)) return true // ::
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return true // ::1
  if ((bytes[0]! & 0xfe) === 0xfc) return true // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true // fe80::/10 link-local
  return false
}

function ipv4MappedInIpv6(bytes: number[]): number[] | null {
  const isMapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  return isMapped ? bytes.slice(12) : null
}

function ipv4Bytes(text: string): number[] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}

// Written out rather than trusted to a regex because the address may hide an IPv4
// suffix (`::ffff:127.0.0.1`) or use the compressed hex form of the same address
// (`::ffff:7f00:1`), and both have to reach the same verdict.
function ipv6Bytes(address: string): number[] | null {
  const marker = address.indexOf('::')
  const head = parseGroups(marker === -1 ? address : address.slice(0, marker))
  if (head === null) return null
  if (marker === -1) return head.length === 8 ? toBytes(head) : null

  const tail = parseGroups(address.slice(marker + 2))
  if (tail === null) return null
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return toBytes([...head, ...Array<number>(fill).fill(0), ...tail])
}

function toBytes(groups: number[]): number[] {
  return groups.flatMap(group => [(group >> 8) & 0xff, group & 0xff])
}

function parseGroups(text: string): number[] | null {
  if (text === '') return []
  const groups: number[] = []
  for (const part of text.split(':')) {
    if (part.includes('.')) {
      const v4 = ipv4Bytes(part)
      if (!v4) return null
      groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!)
      continue
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
    groups.push(Number.parseInt(part, 16))
  }
  return groups
}
