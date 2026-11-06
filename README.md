# gnista-vundo

The undo history as a tree, for [Gnista](https://github.com/Gnista-Editor/gnista): `M-x vundo` shows the buffer's undo history below it, and moving in the tree takes the buffer back to each state. A port of [vundo](https://github.com/casouri/vundo) 2.4.

## Installing

In `~/.config/gnista/init.ts`:

```ts
gnista.usePackage("Gnista-Editor/gnista-vundo");
gnista.defineKey("global-map", "C-x u", "vundo");
```

Gnista installs it at its newest version tag into `repos/` beside `init.ts`, records the commit in `gnista-lock.json`, and requires it. `M-x package-vc-upgrade` brings it up to date. Pin a version with `{ rev: "v0.1.0" }`. It needs Gnista 0.2.0 or newer.

## Using it

`M-x vundo` in a buffer with undo history, then:

| Key | Does |
| --- | --- |
| `f`, `b` | forward and back along the history |
| `n`, `p` | the node below and above |
| `a` | back to the last branch point |
| `w` | on to the next branch |
| `e` | on to the end of the stem |
| `l`, `r` | the last and next saved nodes |
| `m`, `u` | mark and unmark a node |
| `d` | diff the marked node, or the parent, with this one |
| `RET` | keep this state |
| `q` | go back to where vundo started |

The tree is drawn in ASCII. For Unicode lines, set `vundo-glyph-alist` to the value of `vundo-unicode-symbols`:

```ts
gnista.setVariable("vundo-glyph-alist", gnista.variable("vundo-unicode-symbols") ?? null);
```

## Differences from vundo.el

- `l` and `r` say a node was saved but not when, as Gnista counts saves rather than keeping their times.
- There is no `vundo-popup-mode`.
- Gnista's undo history is steps, which this reads with `gnista.undoHistory` rather than from `buffer-undo-list` and `undo-equiv-table`.

## Credit

This is a port to Gnista of [vundo](https://github.com/casouri/vundo) 2.4, with its `vundo-diff.el`, by Yuan Fu and its contributors, copyright the Free Software Foundation, and distributed in GNU ELPA, under the GNU General Public License version 3 or later. It is not the upstream authors' work as published, and they do not endorse it: report problems with the port here, not upstream.

## Developing

With a Gnista on your PATH (a [release](https://github.com/Gnista-Editor/gnista/releases), or built from source) and TypeScript 5.8 or newer:

```bash
make test
make types
```

The tests in `test/vundo-tests.ts` check the trees vundo draws and the states it moves the buffer to against what vundo.el 2.4 gives in Emacs 30 for the same keys.

## Licence

GPL-3.0-or-later: see `LICENSE`.
