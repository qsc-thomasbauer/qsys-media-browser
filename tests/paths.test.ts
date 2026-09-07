/**
 * The jail.
 *
 * This is the security-critical module - the only thing standing between a
 * scripted IPC call and the rest of the Core's `/media` tree - so it gets the
 * heaviest coverage in the suite. Anything that could plausibly be read as
 * "somewhere else" must be rejected, and the sibling-prefix case in particular
 * (`Audio/ACMEX` for a root of `Audio/ACME`) is the one a naive `startsWith`
 * gets wrong.
 */
import { describe, expect, it } from 'vitest'
import { PathEscapeError, PathJail } from '../src/main/qsys/paths'
import {
  InvalidPathError,
  assertValidName,
  baseVirtual,
  breadcrumbs,
  isWithin,
  joinVirtual,
  normalizeVirtual,
  parentVirtual,
  splitExtension,
  splitVirtual
} from '../src/shared/vpath'

describe('PathJail with a root folder', () => {
  const jail = new PathJail('Messages/ACME')

  it('exposes its root and reports being jailed', () => {
    expect(jail.root).toBe('Messages/ACME')
    expect(jail.isUnjailed).toBe(false)
  })

  it('maps the virtual root onto the configured folder', () => {
    expect(jail.toCore('/')).toBe('Messages/ACME')
    expect(jail.toCore('')).toBe('Messages/ACME')
    expect(jail.toVirtual('Messages/ACME')).toBe('/')
  })

  it('maps paths in both directions', () => {
    expect(jail.toCore('/Evening/spot.wav')).toBe('Messages/ACME/Evening/spot.wav')
    expect(jail.toCore('Evening/spot.wav')).toBe('Messages/ACME/Evening/spot.wav')
    expect(jail.toVirtual('Messages/ACME/Evening/spot.wav')).toBe('/Evening/spot.wav')
  })

  it('tolerates the API returning leading slashes', () => {
    // Top-level folders come back as `/Audio`, files as `Audio/x.mp3`.
    expect(jail.toVirtual('/Messages/ACME/x.wav')).toBe('/x.wav')
  })

  describe('rejects traversal', () => {
    const attempts = [
      '..',
      '../',
      '/..',
      '/../../etc',
      '/Evening/../../OtherCustomer',
      'a/../../b',
      './..',
      '/./../x',
      '/Evening/./x'
    ]

    for (const attempt of attempts) {
      it(JSON.stringify(attempt), () => {
        expect(() => jail.toCore(attempt)).toThrow()
      })
    }

    it('rejects "." and ".." even when deeply nested', () => {
      expect(() => jail.toCore('/a/b/c/../../../../../../etc/passwd')).toThrow(InvalidPathError)
    })
  })

  describe('rejects paths that are not simply relative', () => {
    it('backslashes, which Windows callers may substitute', () => {
      expect(() => jail.toCore('..\\..\\etc')).toThrow(InvalidPathError)
      expect(() => jail.toCore('/Evening\\spot.wav')).toThrow(InvalidPathError)
    })

    it('null bytes', () => {
      expect(() => jail.toCore('/spot.wav\0.txt')).toThrow(InvalidPathError)
    })

    it('percent-encoded separators, which would double-encode on the wire', () => {
      expect(() => jail.toCore('/..%2f..%2fetc')).toThrow(InvalidPathError)
      expect(() => jail.toCore('/a%2Fb')).toThrow(InvalidPathError)
    })

    it('segments longer than 255 bytes', () => {
      expect(() => jail.toCore(`/${'a'.repeat(256)}`)).toThrow(InvalidPathError)
      // Multi-byte characters count as bytes, not code points.
      expect(() => jail.toCore(`/${'é'.repeat(200)}`)).toThrow(InvalidPathError)
    })

    it('non-strings', () => {
      // A compromised renderer is not obliged to send a string.
      expect(() => jail.toCore(null as unknown as string)).toThrow(InvalidPathError)
      expect(() => jail.toCore(42 as unknown as string)).toThrow(InvalidPathError)
    })
  })

  describe('rejects Core paths outside the root', () => {
    it('a sibling that merely shares the prefix', () => {
      // The case a bare startsWith() check gets wrong.
      expect(jail.contains('Messages/ACMEX')).toBe(false)
      expect(jail.contains('Messages/ACMEX/private.wav')).toBe(false)
      expect(() => jail.toVirtual('Messages/ACMEX/private.wav')).toThrow(PathEscapeError)
      expect(jail.tryToVirtual('Messages/ACMEX/private.wav')).toBeNull()
    })

    it('a different customer folder', () => {
      expect(jail.tryToVirtual('Messages/OtherCustomer/private.wav')).toBeNull()
    })

    it('an ancestor of the root', () => {
      expect(jail.tryToVirtual('Messages')).toBeNull()
      expect(jail.tryToVirtual('')).toBeNull()
    })

    it('but accepts the root itself and its descendants', () => {
      expect(jail.contains('Messages/ACME')).toBe(true)
      expect(jail.contains('Messages/ACME/deep/nested/file.wav')).toBe(true)
    })
  })

  it('is case-sensitive, matching the Core filesystem', () => {
    expect(jail.contains('messages/acme')).toBe(false)
  })

  it('permits names that merely look suspicious', () => {
    // Only an exact `.` or `..` segment is traversal. Everything else is a
    // legal filename on the Core's Linux filesystem, and refusing it would
    // make a real file unmanageable for no security gain - notably `....`,
    // which is four dots, not two traversals.
    expect(jail.toCore('/..foo')).toBe('Messages/ACME/..foo')
    expect(jail.toCore('/a..b')).toBe('Messages/ACME/a..b')
    expect(jail.toCore('/50% off.mp3')).toBe('Messages/ACME/50% off.mp3')
    expect(jail.toCore('....//')).toBe('Messages/ACME/....')
    expect(jail.toCore('/...')).toBe('Messages/ACME/...')
  })
})

describe('PathJail with allowRootEscape', () => {
  const jail = new PathJail('Messages/ACME', true)

  it('ignores the configured root', () => {
    expect(jail.root).toBe('')
    expect(jail.isUnjailed).toBe(true)
    expect(jail.toCore('/')).toBe('')
    expect(jail.toCore('/Audio/x.wav')).toBe('Audio/x.wav')
    expect(jail.toVirtual('Audio/x.wav')).toBe('/Audio/x.wav')
  })

  it('still applies the structural guards', () => {
    // An admin build is not a different code path - traversal is still refused.
    expect(() => jail.toCore('/../../etc')).toThrow(InvalidPathError)
    expect(() => jail.toCore('/a\0b')).toThrow(InvalidPathError)
  })
})

describe('PathJail with an empty root', () => {
  const jail = new PathJail('')

  it('behaves as the whole tree', () => {
    expect(jail.isUnjailed).toBe(true)
    expect(jail.toVirtual('')).toBe('/')
    expect(jail.toCore('/Audio')).toBe('Audio')
  })
})

describe('root normalisation', () => {
  it('strips stray slashes and backslashes from the configured root', () => {
    for (const root of ['/Messages/ACME', 'Messages/ACME/', '/Messages/ACME/', 'Messages\\ACME']) {
      expect(new PathJail(root).root).toBe('Messages/ACME')
    }
  })
})

describe('URI encoding', () => {
  const jail = new PathJail('')

  it('encodes each segment separately, keeping the separators', () => {
    expect(jail.encode('Audio/my file.mp3')).toBe('Audio/my%20file.mp3')
  })

  it('encodes characters encodeURI would leave alone', () => {
    // The API requires spaces *and* slashes inside names to be encoded, which
    // rules out encodeURI on the whole string.
    expect(jail.encode('Audio/a+b.mp3')).toBe('Audio/a%2Bb.mp3')
    expect(jail.encode('Audio/50% off.mp3')).toBe('Audio/50%25%20off.mp3')
    expect(jail.encode('Audio/track#1.mp3')).toBe('Audio/track%231.mp3')
    expect(jail.encode('Audio/a&b.mp3')).toBe('Audio/a%26b.mp3')
    expect(jail.encode('Audio/a?b.mp3')).toBe('Audio/a%3Fb.mp3')
  })

  it('encodes non-ASCII names', () => {
    expect(jail.encode('Audio/grüße.mp3')).toBe('Audio/gr%C3%BC%C3%9Fe.mp3')
  })

  it('leaves the empty root empty', () => {
    expect(jail.encode('')).toBe('')
  })

  it('round-trips through the full toEncodedCore path', () => {
    const jailed = new PathJail('Messages/ACME')
    expect(jailed.toEncodedCore('/lobby announcement.wav')).toBe(
      'Messages/ACME/lobby%20announcement.wav'
    )
  })
})

describe('virtual path helpers', () => {
  it('normalises', () => {
    expect(normalizeVirtual('')).toBe('/')
    expect(normalizeVirtual('/')).toBe('/')
    expect(normalizeVirtual('//a//b//')).toBe('/a/b')
    expect(normalizeVirtual('a/b')).toBe('/a/b')
  })

  it('splits', () => {
    expect(splitVirtual('/a/b')).toEqual(['a', 'b'])
    expect(splitVirtual('/')).toEqual([])
  })

  it('finds parents and basenames', () => {
    expect(parentVirtual('/a/b/c')).toBe('/a/b')
    expect(parentVirtual('/a')).toBe('/')
    expect(parentVirtual('/')).toBe('/')
    expect(baseVirtual('/a/b.wav')).toBe('b.wav')
    expect(baseVirtual('/')).toBe('')
  })

  it('joins with validation', () => {
    expect(joinVirtual('/a', 'b.wav')).toBe('/a/b.wav')
    expect(joinVirtual('/', 'b.wav')).toBe('/b.wav')
    expect(() => joinVirtual('/a', '../b')).toThrow(InvalidPathError)
    expect(() => joinVirtual('/a', '')).toThrow(InvalidPathError)
  })

  it('validates names', () => {
    expect(assertValidName('  spot.wav  ')).toBe('spot.wav')
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a\0b']) {
      expect(() => assertValidName(bad)).toThrow(InvalidPathError)
    }
  })

  it('splits stem from extension the way the API does', () => {
    // Drives the rename fix: the Core takes the stem and re-appends the
    // extension, so getting this boundary wrong doubles or truncates names.
    expect(splitExtension('image.jpeg')).toEqual({ stem: 'image', ext: 'jpeg' })
    expect(splitExtension('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: 'gz' })
    expect(splitExtension('clip.WAV')).toEqual({ stem: 'clip', ext: 'WAV' })

    // No extension: a bare name, a dotfile, and a trailing dot.
    expect(splitExtension('README')).toEqual({ stem: 'README', ext: '' })
    expect(splitExtension('.htaccess')).toEqual({ stem: '.htaccess', ext: '' })
    expect(splitExtension('.jpeg')).toEqual({ stem: '.jpeg', ext: '' })
    expect(splitExtension('trailing.')).toEqual({ stem: 'trailing.', ext: '' })
    expect(splitExtension('')).toEqual({ stem: '', ext: '' })

    // A folder called `v1.2` must not lose its ".2" - callers check the type.
    expect(splitExtension('v1.2')).toEqual({ stem: 'v1', ext: '2' })
  })

  it('detects containment, which blocks moving a folder into itself', () => {
    expect(isWithin('/a/b', '/a')).toBe(true)
    expect(isWithin('/a', '/a')).toBe(true)
    expect(isWithin('/ab', '/a')).toBe(false)
    expect(isWithin('/a', '/a/b')).toBe(false)
    expect(isWithin('/anything', '/')).toBe(true)
  })

  it('builds breadcrumb trails', () => {
    expect(breadcrumbs('/')).toEqual([])
    expect(breadcrumbs('/a/b')).toEqual([
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' }
    ])
  })
})
