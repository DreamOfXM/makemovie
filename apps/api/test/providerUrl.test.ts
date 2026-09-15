import { describe, expect, it } from 'vitest'
import { checkProviderBaseUrl } from '../src/lib/providerUrl.js'

const strict = { allowPrivate: false }
const permissive = { allowPrivate: true }

function error(url: string, options = strict): string | undefined {
  return checkProviderBaseUrl(url, options).error
}

describe('checkProviderBaseUrl', () => {
  it('accepts the shapes a real gateway is offered in', () => {
    for (const url of [
      'https://dashscope.aliyuncs.com',
      'https://api.openai.com/v1',
      'https://generativelanguage.googleapis.com/v1beta',
      'http://gateway.example.com:8443/v1',
    ]) {
      expect(checkProviderBaseUrl(url, strict)).toEqual({ ok: true, url })
    }
  })

  it('stores the address as typed, because adapters append their path to it', () => {
    // Rewriting this through `new URL().toString()` would add a trailing slash to a
    // bare host, and every adapter builds `${baseUrl}${PATH}` — the result would be a
    // double slash that some gateways answer with a 404.
    expect(checkProviderBaseUrl('  https://api.example.com  ', strict).url).toBe('https://api.example.com')
    expect(checkProviderBaseUrl('https://api.example.com/', strict).url).toBe('https://api.example.com/')
  })

  it('refuses anything the worker cannot call over http(s)', () => {
    expect(error('file:///etc/passwd')).toContain('http(s)')
    expect(error('gopher://169.254.169.254/')).toContain('http(s)')
    expect(error('mock://local')).toContain('http(s)')
    expect(error('not a url')).toContain('absolute')
    expect(error('   ')).toContain('empty')
  })

  it('refuses credentials in the URL, which every provider sends as a header instead', () => {
    expect(error('https://user:pw@api.example.com')).toContain('credentials')
    expect(error('https://user@api.example.com')).toContain('credentials')
  })

  it('refuses the addresses that reach the worker’s own network', () => {
    const blocked = [
      'http://127.0.0.1:18080/v1',
      'http://localhost:18080/v1',
      'http://db.internal/',
      'http://gateway.local/v1',
      'http://10.1.2.3/v1',
      'http://172.16.0.1/v1',
      'http://192.168.0.1/v1',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/v1',
      'http://100.64.0.1/v1',
      'http://[::1]:8080/v1',
      'http://[fd00::1]/v1',
      'http://[fe80::1]/v1',
    ]
    for (const url of blocked) expect(error(url), url).toContain('private, loopback or link-local')
  })

  it('refuses the same address however it is spelled', () => {
    // 127.0.0.1 written as a decimal, a hex, an octal-prefixed and an IPv6-mapped
    // literal. The first three only look public until the URL parser normalises them.
    const loopback = [
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0177.0.0.1/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
    ]
    for (const url of loopback) expect(error(url), url).toContain('private, loopback or link-local')
  })

  it('leaves public addresses alone', () => {
    expect(error('https://api.example.com/v1')).toBeUndefined()
    expect(error('http://203.0.113.9/v1')).toBeUndefined()
    expect(error('https://[2001:db8::5]/v1')).toBeUndefined()
    // A name that merely contains a private-looking label is still a public lookup.
    expect(error('https://api-10-0-0-1.example.com/v1')).toBeUndefined()
  })

  it('lets an operator who self-hosts a gateway opt back in', () => {
    expect(checkProviderBaseUrl('http://localhost:18080/v1', permissive).ok).toBe(true)
    expect(checkProviderBaseUrl('http://192.168.0.7/v1', permissive).ok).toBe(true)
    // Opting in to private addresses does not opt in to a non-network scheme or a
    // credential — those are refused whatever the flag says.
    expect(checkProviderBaseUrl('file:///etc/passwd', permissive).ok).toBe(false)
    expect(checkProviderBaseUrl('https://user:pw@api.example.com', permissive).ok).toBe(false)
  })
})
