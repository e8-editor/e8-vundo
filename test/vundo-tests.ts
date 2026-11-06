// SPDX-License-Identifier: GPL-3.0-or-later
//
// vundo's tests, with ERT: the trees it draws and the states it moves the
// buffer to are those vundo.el 2.4 gives in Emacs 30 for the same keys.
// `make test` runs them in gnista --batch, as CI does.

import { ertDeftest, should, shouldEqual, shouldError } from "ert";
import "vundo";

const TREE = " *vundo tree*";

/** A buffer of its own for a test, edited by typing `keys`. */
function setup(name: string, keys: string): void {
  gnista.call("switch-to-buffer", name);
  if (keys !== "") gnista.executeKbdMacro(keys);
}

function text(name: string): string {
  return gnista.withCurrentBuffer(name, () => gnista.bufferText());
}

/** The tree, with a * where point is, just after the current node. */
function tree(): string {
  should(gnista.getBuffer(TREE) !== undefined, "the tree is shown");
  return gnista.withCurrentBuffer(TREE, () => {
    const chars = Array.from(gnista.bufferText());
    const at = gnista.point() - gnista.pointMin();
    return chars.slice(0, at).join("") + "*" + chars.slice(at).join("");
  });
}

/**
 * Presses each of the moves in the vundo buffer, comparing the tree and the
 * buffer's text after each with what Emacs's vundo shows.
 */
function check(name: string, steps: [string, string, string][]): void {
  for (const [keys, wantTree, wantText] of steps) {
    if (keys !== "") gnista.executeKbdMacro(keys);
    shouldEqual(tree(), wantTree, `tree after ${JSON.stringify(keys)}`);
    shouldEqual(text(name), wantText, `text after ${JSON.stringify(keys)}`);
  }
}

ertDeftest("vundo-moving-in-the-tree-takes-the-buffer-to-each-state", () => {
  setup("t1", "a C-a b C-a c C-/ C-/ C-e d C-a e");
  gnista.executeKbdMacro("M-x v u n d o RET");
  check("t1", [
    ["", "o--o--o--o*\n   `--o--o", "ead"],
    ["b", "o--o--o*--o\n   `--o--o", "ad"],
    ["b", "o--o*--o--o\n   `--o--o", "a"],
    // The root has one child: no node below.
    ["n", "o--o*--o--o\n   `--o--o", "a"],
    ["f", "o--o--o*--o\n   `--o--o", "ad"],
    ["f", "o--o--o--o*\n   `--o--o", "ead"],
    ["p", "o--o--o--o*\n   `--o--o", "ead"],
    ["a", "o--o--o*--o\n   `--o--o", "ad"],
    ["e", "o--o--o--o*\n   `--o--o", "ead"],
  ]);
  gnista.executeKbdMacro("RET");
  shouldEqual(gnista.getBuffer(TREE), undefined, "the tree is gone");
  shouldEqual(text("t1"), "ead");
  shouldEqual(gnista.bufferName(), "t1");
});

ertDeftest("vundo-branches-below-a-node-are-drawn-down-the-side", () => {
  setup("t2", "a C-a b C-a c C-/ C-e d C-a C-/ C-/ C-/ C-e x C-a y");
  gnista.executeKbdMacro("M-x v u n d o RET");
  const rest = "\n      |--o\n      `--o";
  check("t2", [
    ["", `o--o--o--o--o*${rest}`, "ybax"],
    ["b", `o--o--o--o*--o${rest}`, "bax"],
    ["b", `o--o--o*--o--o${rest}`, "ba"],
    ["b", `o--o*--o--o--o${rest}`, "a"],
    ["n", `o--o*--o--o--o${rest}`, "a"],
    ["w", `o--o--o--o*--o${rest}`, "bax"],
    ["e", `o--o--o--o--o*${rest}`, "ybax"],
  ]);
  gnista.executeKbdMacro("q");
});

ertDeftest("vundo-quitting-rolls-the-buffer-back", () => {
  setup("t3", "a C-a b C-a c");
  gnista.executeKbdMacro("M-x v u n d o RET");
  check("t3", [
    ["", "o--o--o--o*", "cba"],
    ["b", "o--o--o*--o", "ba"],
    ["b", "o--o*--o--o", "a"],
  ]);
  gnista.executeKbdMacro("q");
  shouldEqual(text("t3"), "cba");
  shouldEqual(gnista.getBuffer(TREE), undefined, "the tree is gone");
  // The buffer is writable again, and undo carries on as before.
  gnista.executeKbdMacro("C-e z C-/");
  shouldEqual(text("t3"), "cba");
});

ertDeftest("vundo-going-back-and-confirming-keeps-the-state-and-trims-what-leads-nowhere-new", () => {
  setup("t4", "a C-a b C-a c");
  // Back and forward again: the two undos lead nowhere new, so they go.
  gnista.executeKbdMacro("M-x v u n d o RET b f RET");
  shouldEqual(text("t4"), "cba");
  shouldEqual(gnista.undoHistory().length, 3);
  // Back twice: the undos are the way to this state, so they stay.
  gnista.executeKbdMacro("M-x v u n d o RET b b RET");
  shouldEqual(text("t4"), "a");
  shouldEqual(gnista.undoHistory().length, 5);
  gnista.executeKbdMacro("C-e d M-x v u n d o RET");
  shouldEqual(tree(), "o--o--o*\n   `--o--o");
  gnista.executeKbdMacro("q");
});

ertDeftest("vundo-needs-history", () => {
  setup("t5", "");
  const e = shouldError(() => gnista.executeKbdMacro("M-x v u n d o RET"), { type: "user-error" });
  shouldEqual(e.message, "There is no undo history");
});

ertDeftest("vundo-d-shows-what-the-parent-state-changed", () => {
  setup("t6", "o n e RET C-a t w o");
  gnista.executeKbdMacro("M-x v u n d o RET");
  // Three lines high, along the bottom of the frame.
  shouldEqual(gnista.windowSize(gnista.selectedWindow())?.totalHeight, 3);
  gnista.executeKbdMacro("d");
  const diff = text("*vundo-diff-t6*");
  should(diff.startsWith("vundo-diff: t6\n"), diff);
  should(diff.includes("--- <t6> [mod 2] (Parent)\n+++ <t6> [mod 3] (Current)\n"), diff);
  should(diff.includes("\n one\n+two\n"), diff);
  // The buffer is as it was, and so is the tree.
  shouldEqual(text("t6"), "one\ntwo");
  shouldEqual(tree(), "o--o--o--o*");
});
