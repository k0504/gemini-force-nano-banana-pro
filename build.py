#!/usr/bin/env python
# Concatenates src/*.js, in file-name order, into the userscript at the
# repository root. The parts share one closure - the whole script is a single
# IIFE, opened by 00-header and closed by 99-footer - so they cannot be loaded
# as separate @require files and are joined here instead.
#
# The output is the released file: Greasy Fork serves it and the development
# loader requires it by path, so neither has to know this directory exists.
#
# Run it after editing anything under src/, or leave `python build.py --watch`
# running and edit freely. `python build.py --check` builds into memory and
# reports whether the file on disk already matches, which is what the split was
# verified with: a rebuild had to reproduce the file it came from byte for byte.
import io
import os
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
OUT = os.path.join(ROOT, 'gemini-imgen-enhancer.user.js')


def parts():
    names = sorted(n for n in os.listdir(SRC) if n.endswith('.js'))
    if not names:
        raise SystemExit('build: src/ holds no .js parts')
    return [os.path.join(SRC, n) for n in names]


def version_of(path, marker, tail):
    for line in io.open(path, encoding='utf-8', newline=''):
        if marker in line:
            rest = line.split(marker, 1)[1]
            return rest.split(tail, 1)[0].strip() if tail else rest.strip()
    return None


def check_version():
    """The page reports VERSION on #gpie-style[data-version], and AGENTS.md tells
    the next engineer to read that attribute before judging any behaviour. It
    has to be the version the metadata block declares, or that reading is worse
    than none. GM_info is not a usable owner: under the development loader it
    reports the stub's frozen version, not this one."""
    declared = version_of(os.path.join(SRC, '00-header.js'), '// @version', '')
    stamped = version_of(os.path.join(SRC, '01-protocol.js'), "var VERSION = '", "'")
    if declared is None or stamped is None:
        raise SystemExit('build: could not read both version declarations')
    if declared != stamped:
        raise SystemExit('build: @version is ' + declared + ' but VERSION is '
                         + stamped + '; the page would report a build that was never released')
    return declared


def build():
    check_version()
    chunks = []
    for path in parts():
        body = io.open(path, encoding='utf-8', newline='').read()
        # Each part is stored with exactly one trailing newline, which is the
        # line break between it and the next part rather than a blank line.
        chunks.append(body[:-1] if body.endswith('\n') else body)
    return '\n'.join(chunks) + '\n'


def stamp():
    return time.strftime('%H:%M:%S')


def watch():
    # Polling rather than a file-system watcher, so the script keeps its promise
    # of needing nothing installed. An editor writing a part twice within one
    # interval still triggers a build, because the second write moves the mtime.
    print('build --watch: watching src/, press Ctrl+C to stop')
    seen = {}
    while True:
        now = dict((path, os.path.getmtime(path)) for path in parts())
        if now != seen:
            if seen:
                changed = [os.path.basename(p) for p in now if now.get(p) != seen.get(p)]
                print(stamp(), 'build:', ', '.join(sorted(changed)))
            io.open(OUT, 'w', encoding='utf-8', newline='').write(build())
            seen = now
        time.sleep(0.5)


def main():
    if '--watch' in sys.argv:
        try:
            watch()
        except KeyboardInterrupt:
            print('build --watch: stopped')
        return 0
    built = build()
    if '--check' in sys.argv:
        current = io.open(OUT, encoding='utf-8', newline='').read() if os.path.exists(OUT) else None
        if current == built:
            print('build --check: the built script matches the file on disk')
            return 0
        print('build --check: the built script DIFFERS from the file on disk')
        return 1
    io.open(OUT, 'w', encoding='utf-8', newline='').write(built)
    print('build: wrote', os.path.relpath(OUT, ROOT), 'from', len(parts()), 'parts,',
          built.count('\n'), 'lines')
    return 0


if __name__ == '__main__':
    sys.exit(main())
