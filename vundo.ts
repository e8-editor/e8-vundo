// SPDX-License-Identifier: GPL-3.0-or-later
//
// Visual undo, after vundo.el 2.4 (https://github.com/casouri/vundo), with
// vundo-diff.el: M-x vundo shows the buffer's undo history as a tree below
// it, and moving in the tree takes the buffer back to each state.
//
//   f, b  forward and back        n, p  the node below and above
//   a     back to the branch      w     on to the next branch
//   e     on to the end of a stem l, r  the last and next saved nodes
//   m, u  mark and unmark a node  d     diff the marked (or parent) node
//   RET   keep this state         q     go back to where vundo started
//
// E8 keeps undo history as steps, which vundo reads with
// e8.undoHistory, where Emacs's vundo reads buffer-undo-list and
// undo-equiv-table: a step that undid another leaves the buffer as it was
// before that one, the same node of the tree.
//
// Copyright (C) 2019-2023 Free Software Foundation, Inc.
// Copyright (C) 2026 The E8 contributors
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { diffNoSelect } from "diff";
import { forwardLine, regexpQuote } from "subr";

const ascii: [string, string][] = [
  ["selected-node", "x"],
  ["node", "o"],
  ["horizontal-stem", "-"],
  ["vertical-stem", "|"],
  ["branch", "|"],
  ["last-branch", "`"],
];
const unicode: [string, string][] = [
  ["selected-node", "●"],
  ["node", "○"],
  ["horizontal-stem", "─"],
  ["vertical-stem", "│"],
  ["branch", "├"],
  ["last-branch", "└"],
];

e8.defineVariable({ name: "vundo-ascii-symbols", doc: "ASCII symbols to draw vundo tree.", value: ascii });
e8.defineVariable({ name: "vundo-unicode-symbols", doc: "Unicode symbols to draw vundo tree.", value: unicode });
e8.defineVariable({
  name: "vundo-glyph-alist",
  doc: 'The characters the tree is drawn with, as [part, character] pairs for node, selected-node, horizontal-stem, vertical-stem, branch and last-branch. Set it to the value of vundo-unicode-symbols to draw with Unicode lines.',
  value: ascii,
});
e8.defineVariable({ name: "vundo-roll-back-on-quit", doc: "If non-nil, vundo will roll back the change when it quits.", value: true });
e8.defineVariable({
  name: "vundo-highlight-saved-nodes",
  doc: "If non-nil, vundo will highlight nodes which have been saved and then modified, the most recent in vundo-last-saved.",
  value: true,
});
e8.defineVariable({ name: "vundo-window-max-height", doc: "The maximum height of the vundo window.", value: 3 });
e8.defineVariable({ name: "vundo-window-side", doc: 'The vundo window pops up on this side: "bottom" or "top".', value: "bottom" });
e8.defineVariable({ name: "vundo-compact-display", doc: "Show a more compact tree display if non-nil: one stem character between nodes, not two.", value: false });
e8.defineVariable({
  name: "vundo-diff-quit",
  doc: 'If non-nil, bury the vundo-diff window when vundo is quit; "kill" kills its buffer too.',
  value: true,
});
e8.defineHook("vundo-pre-enter-hook", "Functions called when entering vundo, in the buffer vundo was called in, before vundo sets up.");
e8.defineHook("vundo-post-exit-hook", "Functions called when exiting vundo, in the original buffer, after vundo cleans up.");
e8.defineHook("vundo-after-undo-functions", "Functions called after vundo motions, with the original buffer.");
e8.defineHook("vundo-diff-setup-hook", "Functions called in the vundo-diff buffer after it is set up.");

e8.defineFace({ name: "vundo-default", doc: "Default face used in vundo buffer.", attributes: { inherit: "default" } });
e8.defineFace({ name: "vundo-node", doc: "Face for nodes in the undo tree.", attributes: { inherit: "vundo-default" } });
e8.defineFace({ name: "vundo-stem", doc: "Face for stems between nodes in the undo tree.", attributes: { inherit: "vundo-default" } });
e8.defineFace({ name: "vundo-branch-stem", doc: "Face for branching stems in the undo tree.", attributes: { inherit: "vundo-stem", weight: "bold" } });
e8.defineFace({
  name: "vundo-highlight",
  doc: "Face for the highlighted node in the undo tree.",
  attributes: { inherit: "vundo-node", weight: "bold" },
  light: { foreground: "red" },
  dark: { foreground: "yellow" },
});
e8.defineFace({
  name: "vundo-saved",
  doc: "Face for saved nodes in the undo tree.",
  attributes: { inherit: "vundo-node" },
  light: { foreground: "dark green" },
  dark: { foreground: "light green" },
});
e8.defineFace({ name: "vundo-last-saved", doc: "Face for the last saved node in the undo tree.", attributes: { inherit: "vundo-saved", weight: "bold" } });
e8.defineFace({
  name: "vundo-diff-highlight",
  doc: "Face for nodes marked for diff in the undo tree.",
  attributes: { inherit: "vundo-highlight" },
  light: { foreground: "DodgerBlue4" },
  dark: { foreground: "DodgerBlue1" },
});

// Undo history to mod list.

/**
 * A modification in undo history, which is also the buffer state after it
 * and the node showing that state, as vundo-m. Mod 0 is the state before
 * any; mod i is the state after the history's step i - 1.
 */
interface Mod {
  idx: number;
  children: Mod[];
  parent?: Mod;
  prevEqv?: Mod;
  nextEqv?: Mod;
  /** Where the node is drawn in the vundo buffer: just after it. */
  point?: number;
  /** If the state before this mod was saved, which save it was. */
  timestamp?: number;
}

/** The mod list of the current buffer's history, as vundo--mod-list-from, with the tree built. */
function modListFrom(): Mod[] {
  const history = e8.undoHistory();
  const mods: Mod[] = [{ idx: 0, children: [] }];
  for (const step of history) mods.push({ idx: mods.length, children: [], timestamp: step.saved });
  buildTree(mods, history);
  return mods;
}

/** The master mod of MOD's equivalence list: the one with the smallest index. */
function masterEqvModOf(mod: Mod): Mod {
  while (mod.prevEqv) mod = mod.prevEqv;
  return mod;
}

/** All the modifications equivalent to MOD, by index. */
function eqvListOf(mod: Mod): Mod[] {
  while (mod.nextEqv) mod = mod.nextEqv;
  const list = [mod];
  while (mod.prevEqv) {
    mod = mod.prevEqv;
    list.unshift(mod);
  }
  return list;
}

/** Connects the mods of LIST, in order, as one equivalence list. */
function eqvMerge(list: Mod[]): void {
  list.forEach((m, i) => {
    m.prevEqv = list[i - 1];
    m.nextEqv = list[i + 1];
  });
}

function eqvMergeMod(m1: Mod, m2: Mod): void {
  const all = [...new Set([...eqvListOf(m1), ...eqvListOf(m2)])];
  eqvMerge(all.sort((a, b) => a.idx - b.idx));
}

/**
 * Connects equivalent modifications and builds the tree, as
 * vundo--build-tree: only a step that is not an undo makes a new state, a
 * child of the state before it; an undo joins the state before the step it
 * undid.
 */
function buildTree(mods: Mod[], history: { undid?: number }[]): void {
  for (let m = 1; m < mods.length; m++) {
    const mod = mods[m];
    const undid = history[m - 1].undid;
    if (undid !== undefined) {
      eqvMergeMod(mods[undid], mod);
      continue;
    }
    const parent = masterEqvModOf(mods[m - 1]);
    mod.parent = parent;
    // Later mods first, as the tree is drawn depth first.
    parent.children = [mod, ...parent.children].sort((a, b) => b.idx - a.idx);
  }
}

// Timestamps.

/** Each saved node, by its master mod, and which save it was, latest first, as vundo--record-timestamps. */
function recordTimestamps(mods: Mod[]): [Mod, number][] {
  const timestamps = new Map<Mod, number>();
  for (let idx = 1; idx < mods.length; idx++) {
    const ts = mods[idx].timestamp;
    if (ts === undefined) continue;
    const master = masterEqvModOf(mods[idx - 1]);
    timestamps.set(master, Math.max(ts, timestamps.get(master) ?? ts));
  }
  return [...timestamps].sort((a, b) => b[1] - a[1]);
}

/** The ARGth saved node before NODE, or after it if ARG is negative, as vundo--find-last-saved. */
function findLastSaved(node: Mod, arg = 1): Mod | undefined {
  const past = arg >= 0;
  let count = Math.abs(arg);
  const master = masterEqvModOf(node);
  let last: Mod | undefined;
  if (state.timestamps.some(([n]) => n === master)) {
    last = master;
  } else {
    let val = past ? -1 : Infinity;
    for (const [n] of state.timestamps) {
      if (past ? val < n.idx && n.idx < master.idx : val > n.idx && n.idx > master.idx) {
        val = n.idx;
        last = n;
      }
    }
    if (last) count--;
  }
  if (last && count > 0) {
    const vt = past ? state.timestamps : [...state.timestamps].reverse();
    const at = vt.findIndex(([n]) => n === last);
    return vt[at + count]?.[0];
  }
  return last;
}

/** A node's timestamp, or, for the current node of an unmodified file's buffer, that it is saved. */
function nodeTimestamp(mods: Mod[], node: Mod, noBuffer = false): number | undefined {
  const master = masterEqvModOf(node);
  const ts = state.timestamps.find(([n]) => n === master)?.[1];
  if (ts !== undefined) return ts;
  if (noBuffer || node !== currentNode(mods)) return undefined;
  return e8.withCurrentBuffer(state.origBuffer, () =>
    e8.variable("buffer-file-name") && !e8.bufferModified() ? Number.MAX_SAFE_INTEGER : undefined,
  );
}

// Draw tree.

const BUFFER = " *vundo tree*";

/** Translates the Unicode tree characters in TEXT to those vundo-glyph-alist gives. */
function translate(text: string): string {
  const parts: { [ch: string]: string } = { "○": "node", "●": "selected-node", "─": "horizontal-stem", "│": "vertical-stem", "├": "branch", "└": "last-branch" };
  const alist = e8.variable("vundo-glyph-alist");
  const glyphs = new Map(Array.isArray(alist) ? (alist as [string, string][]) : ascii);
  return [...text].map((ch) => glyphs.get(parts[ch]) ?? ch).join("");
}

const eolp = (): boolean => e8.point() === e8.pointMax() || e8.charAfter() === "\n";

/** Moves to the next line at column COL, making the line and the column if there are none, as vundo--next-line-at-column. */
function nextLineAtColumn(col: number): void {
  if (!(forwardLine(1) === 0 && e8.point() !== e8.pointMax())) {
    e8.gotoChar(e8.pointMax());
    e8.insert("\n");
  }
  e8.moveToColumn(col);
  if (e8.currentColumn() !== col) e8.letBind({ "indent-tabs-mode": false }, () => e8.indentTo(col));
}

/** Draws the tree of MODS in the current buffer, as vundo--draw-tree. */
function drawTree(mods: Mod[]): void {
  const compact = e8.variable("vundo-compact-display") === true;
  const room = `\\(?: \\{${compact ? 3 : 4},\\}\\|$\\)`;
  const branchChars = `${regexpQuote(translate("├"))}\\|${regexpQuote(translate("└"))}`;
  const highlightSaved = e8.variable("vundo-highlight-saved-nodes") !== null && e8.variable("vundo-highlight-saved-nodes") !== false;
  e8.letBind({ "inhibit-read-only": true, "inhibit-modification-hooks": true }, () => {
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    const queue: Mod[] = [mods[0]];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const parent = node.parent;
      const siblings = parent?.children ?? [];
      const onlyChild = parent !== undefined && siblings.length === 1;
      const lastChild = parent !== undefined && node === siblings[siblings.length - 1];
      const nodeFace = highlightSaved && nodeTimestamp(mods, node, true) !== undefined ? "vundo-saved" : "vundo-node";
      const stemFace = onlyChild ? "vundo-stem" : "vundo-branch-stem";
      const stem = (text: string) => e8.insert(e8.propertize(translate(text), { face: stemFace }));
      if (parent === undefined) {
        e8.insert(e8.propertize(translate("○"), { face: nodeFace }));
      } else {
        e8.gotoChar(parent.point!);
        const planned = e8.point();
        // A node in the way: try the next line.
        while (!e8.lookingAt(room)) {
          nextLineAtColumn(Math.max(0, e8.currentColumn() - 1));
          const replace = e8.lookingAt(branchChars) ? "├" : "│";
          if (!eolp()) e8.deleteRegion(e8.point(), e8.point() + 1);
          stem(replace);
        }
        // Room for the new node.
        if (!e8.lookingAt("$")) e8.deleteRegion(e8.point(), e8.point() + (compact ? 2 : 3));
        if (e8.point() === planned) {
          stem(compact ? "─" : "──");
        } else {
          // The line breaks: the stem drawn last becomes a branch.
          e8.deleteRegion(e8.point() - 1, e8.point());
          stem(lastChild ? (compact ? "└─" : "└──") : compact ? "├─" : "├──");
        }
        e8.insert(e8.propertize(translate("○"), { face: nodeFace }));
      }
      node.point = e8.point();
      e8.putTextProperty(e8.point() - 1, e8.point(), "vundo-node", node.idx);
      queue.unshift(...node.children);
    }
  });
}

// Vundo buffer and invocation.

/** What the vundo buffer shows, as its buffer-local variables in vundo.el. */
const state = {
  origBuffer: undefined as unknown as e8.Buffer,
  mods: [] as Mod[],
  timestamps: [] as [Mod, number][],
  /** The node quitting goes back to, by index. */
  rollBackTo: undefined as number | undefined,
  highlight: undefined as number | undefined,
  lastSavedHighlight: undefined as number | undefined,
  /** The node marked for diff, by index. */
  marked: undefined as number | undefined,
  markedHighlight: undefined as number | undefined,
};

/** The node showing the buffer's state now: the master of the last mod's equivalents. */
function currentNode(mods: Mod[]): Mod {
  return masterEqvModOf(mods[mods.length - 1]);
}

/** Makes or moves an overlay over the node at POINT, as vundo--highlight-node does. */
function placeOverlay(overlay: number | undefined, point: number, props: { [name: string]: e8.Value }): number {
  if (overlay === undefined) {
    overlay = e8.makeOverlay(point - 1, point);
    for (const [name, value] of Object.entries(props)) e8.overlayPut(overlay, name, value);
  }
  e8.moveOverlay(overlay, point - 1, point);
  return overlay;
}

/** Highlights the last saved node, or the current one if it is saved later, as vundo--highlight-last-saved-node. */
function highlightLastSavedNode(mods: Mod[]): void {
  const last = state.timestamps[0];
  const cur = currentNode(mods);
  const curTs = nodeTimestamp(mods, cur);
  const node = last && curTs !== undefined ? (last[1] < curTs ? cur : last[0]) : last ? last[0] : curTs !== undefined ? cur : undefined;
  if (node?.point === undefined) return;
  state.lastSavedHighlight = placeOverlay(state.lastSavedHighlight, node.point, { face: "vundo-last-saved" });
}

/**
 * Reads the original buffer's history again and redraws the tree, with the
 * current node highlighted and point on it, as vundo--refresh-buffer.
 */
function refresh(): void {
  const mods = e8.withCurrentBuffer(state.origBuffer, modListFrom);
  state.mods = mods;
  state.timestamps = recordTimestamps(mods);
  drawTree(mods);
  const cur = currentNode(mods);
  // The overlays went with the text.
  for (const key of ["highlight", "lastSavedHighlight", "markedHighlight"] as const) {
    if (state[key] !== undefined) e8.deleteOverlay(state[key]);
    state[key] = undefined;
  }
  state.highlight = placeOverlay(state.highlight, cur.point!, { display: translate("●"), face: "vundo-highlight", priority: 2 });
  e8.gotoChar(cur.point!);
  if (state.marked !== undefined && mods[state.marked]) diffMark(mods[state.marked]);
  if (e8.variable("vundo-highlight-saved-nodes") === true) highlightLastSavedNode(mods);
}

const vundo = e8.defineCommand({
  name: "vundo",
  doc: "Display visual undo for the current buffer: its undo history as a tree, below it, to move about in.",
  run: () => {
    const undoList = e8.variable("buffer-undo-list");
    if (!Array.isArray(undoList) || undoList.length === 0) e8.userError("There is no undo history");
    if (e8.variable("buffer-read-only") === true) e8.userError("Buffer is read-only");
    e8.runHooks("vundo-pre-enter-hook");
    vundo1(e8.currentBuffer());
    const height = Math.max(3, Math.min(Number(e8.variable("vundo-window-max-height")) || 3, e8.withCurrentBuffer(BUFFER, () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()).split("\n").length)));
    let window = e8.windowList().find((w) => e8.windowBuffer(w) === BUFFER);
    if (window === undefined) {
      window = e8.splitRootWindow("below", -height);
      e8.setWindowBuffer(window, BUFFER);
    }
    e8.selectWindow(window);
    e8.setWindowDedicatedP(window, true);
    state.rollBackTo = currentNode(state.mods).idx;
    e8.gotoChar(currentNode(state.mods).point!);
  },
});

/** Makes the vundo buffer show BUFFER's history, as vundo-1. */
function vundo1(buffer: e8.Buffer): string {
  e8.getBufferCreate(BUFFER);
  e8.withCurrentBuffer(BUFFER, () => {
    if (!e8.derivedModeP("vundo-mode")) e8.call(vundoMode);
    state.origBuffer = buffer;
    state.marked = undefined;
    refresh();
  });
  return BUFFER;
}

/** Runs BODY in the vundo buffer with the tree up to date, as vundo--check-for-command. */
function checkForCommand(body: () => void): void {
  if (!e8.derivedModeP("vundo-mode")) e8.userError("Not in vundo buffer");
  if (!e8.bufferLiveP(state.origBuffer)) {
    if (e8.yOrNP("Original buffer is gone, kill vundo buffer? ")) e8.call("kill-buffer-and-window");
    e8.userError("");
  }
  // The original buffer may have changed since: read its history again.
  refresh();
  body();
}

// Traverse undo tree.

/** The shortest route from FROM to TO, the mods to undo from SOURCE down to DEST, as vundo--calculate-shortest-route. */
function shortestRoute(from: Mod, to: Mod): number[] | undefined {
  let best: [number, number] | undefined;
  for (const source of eqvListOf(from)) {
    for (const dest of eqvListOf(to)) {
      if (source.idx > dest.idx && (best === undefined || source.idx - dest.idx < best[0] - best[1])) best = [source.idx, dest.idx];
    }
  }
  if (!best) return undefined;
  const route: number[] = [];
  for (let i = best[0]; i >= best[1]; i--) route.push(i);
  return route;
}

/** The latest mod that is a state of its own, not an undo, as vundo--latest-buffer-state. */
function latestBufferState(mods: Mod[]): Mod {
  let max = mods[0];
  for (const mod of mods.slice(1)) if (!mod.prevEqv && mod.idx > max.idx) max = mod;
  return max;
}

/**
 * Moves the original buffer from the CURRENT node's state to DEST's by
 * undoing each step between, as vundo--move-to-node: each undo is a step of
 * the history, so the way back is there too.
 */
function moveToNode(current: Mod, dest: Mod): void {
  const route = shortestRoute(current, dest);
  if (!route) e8.signal("error", "No possible route");
  const [source, target] = [route[0], route[route.length - 1]];
  e8.withCurrentBuffer(state.origBuffer, () => {
    e8.makeLocalVariable("buffer-read-only");
    e8.setVariable("buffer-read-only", true);
    // Mod i is the state after step i - 1, so undoing it is undoing that step.
    e8.letBind({ "inhibit-read-only": true }, () => {
      for (let idx = source; idx > target; idx--) e8.undoStep(idx - 1);
    });
    const win = e8.windowList().find((w) => e8.windowBuffer(w) === e8.bufferName(state.origBuffer));
    if (win !== undefined) e8.setWindowPoint(win, e8.point());
  });
}

/**
 * Forgets the history after the latest state of its own, where the
 * current node is the same state, as vundo--trim-undo-list: what is after
 * it only leads back to states the tree has.
 */
function trimUndoList(current: Mod): void {
  const latest = latestBufferState(state.mods).idx;
  const trim = eqvListOf(current).find((node) => node.idx >= latest);
  if (trim) e8.withCurrentBuffer(state.origBuffer, () => e8.truncateUndo(trim.idx));
}

/** Moves to DEST, trims and redraws, as each vundo motion does. */
function goTo(source: Mod, dest: Mod): void {
  if (source === dest) return;
  moveToNode(source, dest);
  trimUndoList(state.mods[dest.idx]);
  refresh();
}

/** Moves along a stem from the current node, stepping with NEXT until STOP says, as the stem commands do. */
function moveAlong(next: (m: Mod) => Mod | undefined, stop: (m: Mod) => boolean): void {
  checkForCommand(() => {
    let current = currentNode(state.mods);
    const start = current;
    let to = next(current);
    if (!to) return;
    for (;;) {
      moveToNode(current, to);
      current = to;
      to = next(current);
      if (!to || stop(current)) break;
    }
    if (current !== start) {
      trimUndoList(current);
      refresh();
    }
  });
}

const vundoQuit = e8.defineCommand({
  name: "vundo-quit",
  doc: "Quit buffer and window, rolling back the changes vundo made if vundo-roll-back-on-quit is non-nil.",
  run: () => {
    checkForCommand(() => {
      const cur = currentNode(state.mods);
      if (e8.variable("vundo-roll-back-on-quit") === true && state.rollBackTo !== undefined && state.rollBackTo !== cur.idx) {
        moveToNode(cur, state.mods[state.rollBackTo]);
      }
      exit();
    });
  },
});

const vundoConfirm = e8.defineCommand({
  name: "vundo-confirm",
  doc: "Confirm change and close vundo window.",
  run: () => exit(),
});

/** Leaves vundo, the original buffer writable again and its window selected. */
function exit(): void {
  const orig = state.origBuffer;
  e8.withCurrentBuffer(orig, () => e8.setVariable("buffer-read-only", false));
  e8.call("kill-buffer-and-window");
  const window = e8.windowList().find((w) => e8.windowBuffer(w) === e8.bufferName(orig));
  if (window !== undefined) e8.selectWindow(window);
  e8.withCurrentBuffer(orig, () => e8.runHooks("vundo-post-exit-hook"));
}

const vundoForward = e8.defineCommand({
  name: "vundo-forward",
  doc: "Move forward ARG nodes in the undo tree. If ARG < 0, move backward.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    checkForCommand(() => {
      const source = currentNode(state.mods);
      const step = (m: Mod) => (arg > 0 ? m.children[0] : m.parent);
      let dest = source;
      for (let n = Math.abs(arg), next = step(dest); next && n > 0; n--, next = step(dest)) dest = next;
      goTo(source, dest);
    });
    e8.runHooks("vundo-after-undo-functions", state.origBuffer);
  },
});

const vundoBackward = e8.defineCommand({
  name: "vundo-backward",
  doc: "Move back ARG nodes in the undo tree. If ARG < 0, move forward.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => e8.call(vundoForward, -arg),
});

const vundoNext = e8.defineCommand({
  name: "vundo-next",
  doc: "Move to node below the current one. Move ARG steps.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    checkForCommand(() => {
      const source = currentNode(state.mods);
      const parent = source.parent;
      if (!parent) return;
      const siblings = parent.children;
      const idx = siblings.indexOf(source);
      goTo(source, siblings[Math.max(0, Math.min(idx + arg, siblings.length - 1))]);
    });
    e8.runHooks("vundo-after-undo-functions", state.origBuffer);
  },
});

const vundoPrevious = e8.defineCommand({
  name: "vundo-previous",
  doc: "Move to node above the current one. Move ARG steps.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => e8.call(vundoNext, -arg),
});

/** Whether NODE starts a stem: its parent has more than one child. */
const stemRootP = (node: Mod): boolean => (node.parent?.children.length ?? 0) > 1;
/** Whether NODE ends a stem: no children, or more than one. */
const stemEndP = (node: Mod): boolean => node.children.length !== 1;

const vundoStemRoot = e8.defineCommand({
  name: "vundo-stem-root",
  doc: "Move to the beginning of the current stem.",
  run: () => moveAlong((m) => m.parent, stemRootP),
});

const vundoNextRoot = e8.defineCommand({
  name: "vundo-next-root",
  doc: "Move to the beginning of the next stem.",
  run: () => moveAlong((m) => m.children[0], stemRootP),
});

const vundoStemEnd = e8.defineCommand({
  name: "vundo-stem-end",
  doc: "Move to the end of the current stem.",
  run: () => moveAlong((m) => m.children[0], stemEndP),
});

const vundoGotoLastSaved = e8.defineCommand({
  name: "vundo-goto-last-saved",
  doc: "Go back to the first saved node prior to the current node, if any. With a numeric prefix argument, move that many saved nodes back; a negative one moves forward.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    refresh();
    const cur = currentNode(state.mods);
    const dest = findLastSaved(cur, arg);
    if (!dest) {
      e8.message("No such saved node");
      return;
    }
    if (cur !== dest) checkForCommand(() => goTo(currentNode(state.mods), state.mods[dest.idx]));
    e8.message("Node saved");
  },
});

const vundoGotoNextSaved = e8.defineCommand({
  name: "vundo-goto-next-saved",
  doc: "Go to the ARGth saved node after the current node (default 1). A negative ARG goes to the last saved node prior to it.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => e8.call(vundoGotoLastSaved, -arg),
});

const vundoSave = e8.defineCommand({
  name: "vundo-save",
  doc: "Save the buffer vundo is operating on.",
  run: () => {
    checkForCommand(() => e8.withCurrentBuffer(state.origBuffer, () => e8.call("save-buffer")));
    refresh();
  },
});

const vundoInspect = e8.defineCommand({
  name: "vundo--inspect",
  doc: "Print some useful info about the node at point.",
  run: () => {
    const idx = e8.getTextProperty(Math.max(0, e8.point() - 1), "vundo-node");
    const node = typeof idx === "number" ? state.mods[idx] : undefined;
    if (!node) return;
    const children = node.children.length > 0 ? `(${node.children.map((c) => c.idx).join(" ")})` : "nil";
    e8.message(`Parent: ${node.parent?.idx ?? "nil"} States: (${eqvListOf(node).map((m) => m.idx).join(" ")}) Children: ${children}`);
  },
});

// Diff, after vundo-diff.el.

/** Marks NODE, the current node by default, for vundo-diff. */
function diffMark(node: Mod): void {
  state.marked = node.idx;
  state.markedHighlight = placeOverlay(state.markedHighlight, node.point!, { display: translate("●"), face: "vundo-diff-highlight", priority: 1 });
}

const vundoDiffMark = e8.defineCommand({
  name: "vundo-diff-mark",
  doc: "Mark the current node for vundo diff.",
  run: () => diffMark(currentNode(state.mods)),
});

const vundoDiffUnmark = e8.defineCommand({
  name: "vundo-diff-unmark",
  doc: "Unmark the node marked for vundo diff.",
  run: () => {
    state.marked = undefined;
    if (state.markedHighlight !== undefined) e8.deleteOverlay(state.markedHighlight);
    state.markedHighlight = undefined;
  },
});

/** Quits the vundo-diff window, killing its buffer if vundo-diff-quit says, as vundo-diff--quit. */
function diffQuit(): void {
  const name = `*vundo-diff-${e8.bufferName()}*`;
  const window = e8.windowList().find((w) => e8.windowBuffer(w) === name);
  const kill = e8.variable("vundo-diff-quit") === "kill";
  if (window !== undefined) {
    e8.selectWindow(window);
    e8.call("quit-window", kill);
  } else if (kill && e8.bufferLiveP(e8.getBuffer(name))) {
    e8.call("kill-buffer", name);
  }
}

const vundoDiff = e8.defineCommand({
  name: "vundo-diff",
  doc: "Show the differences between the marked node's buffer state, or the current node's parent's, and the current one's.",
  run: () => {
    e8.addHook("vundo-post-exit-hook", diffQuit);
    refresh();
    const orig = state.origBuffer;
    const origName = e8.bufferName(orig) ?? "";
    const current = currentNode(state.mods);
    const marked = state.marked !== undefined ? state.mods[state.marked] : current.parent;
    if (!marked || marked === current) {
      e8.message("vundo diff not available.");
      return;
    }
    const swapped = marked.idx > current.idx;
    // The marked state's text, got by going there and back.
    let markedText = "";
    checkForCommand(() => {
      moveToNode(current, marked);
      markedText = e8.withCurrentBuffer(orig, () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()));
      refresh();
      moveToNode(currentNode(state.mods), state.mods[current.idx]);
      trimUndoList(state.mods[current.idx]);
      refresh();
    });
    const currentText = e8.withCurrentBuffer(orig, () => e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()));
    const [a, b] = swapped ? [current, marked] : [marked, current];
    const [aText, bText] = swapped ? [currentText, markedText] : [markedText, currentText];
    const label = (m: Mod) => `<${origName}> [mod ${m.idx}] (${m === current ? "Current" : state.marked !== undefined ? "Marked" : "Parent"})`;
    const aFile = e8.makeTempFile("vundo-diff", { text: aText });
    const bFile = e8.makeTempFile("vundo-diff", { text: bText });
    const name = `*vundo-diff-${origName}*`;
    try {
      diffNoSelect(aFile, bFile, [label(a), label(b)], name);
    } finally {
      e8.deleteFile(aFile);
      e8.deleteFile(bFile);
    }
    e8.withCurrentBuffer(name, () => {
      e8.letBind({ "inhibit-read-only": true }, () => {
        e8.gotoChar(e8.pointMin());
        e8.insert(e8.propertize("vundo-diff: ", { face: "diff-header" }));
        e8.insert(e8.propertize(origName, { face: ["diff-file-header", "diff-header"] }));
        e8.insert("\n");
      });
      e8.runHooks("vundo-diff-setup-hook");
    });
    e8.call("display-buffer", name);
  },
});

const vundoMode = e8.defineMajorMode({
  name: "vundo-mode",
  modeName: "Vundo",
  parent: "special-mode",
  doc: "Mode for displaying the undo tree.",
  bindings: {
    f: vundoForward,
    "<right>": vundoForward,
    b: vundoBackward,
    "<left>": vundoBackward,
    n: vundoNext,
    "<down>": vundoNext,
    p: vundoPrevious,
    "<up>": vundoPrevious,
    a: vundoStemRoot,
    w: vundoNextRoot,
    e: vundoStemEnd,
    l: vundoGotoLastSaved,
    r: vundoGotoNextSaved,
    q: vundoQuit,
    "C-g": vundoQuit,
    RET: vundoConfirm,
    m: vundoDiffMark,
    u: vundoDiffUnmark,
    d: vundoDiff,
    i: vundoInspect,
  },
  setup: () => {
    for (const [name, value] of [
      ["mode-line-format", null],
      ["truncate-lines", true],
      ["cursor-type", null],
    ] as const) {
      e8.makeLocalVariable(name);
      e8.setVariable(name, value);
    }
  },
});
e8.remapCommand("vundo-mode-map", "save-buffer", vundoSave);
