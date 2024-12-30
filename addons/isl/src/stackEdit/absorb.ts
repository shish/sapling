/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {LineInfo} from '../linelog';
import type {Rev} from './fileStackState';
import type {RecordOf} from 'immutable';

import {assert} from '../utils';
import {FileStackState} from './fileStackState';
import {List, Record, Map as ImMap} from 'immutable';
import {diffLines, splitLines} from 'shared/diff';
import {dedup, nullthrows} from 'shared/utils';

/** A diff chunk analyzed by `analyseFileStack`. */
export type AbsorbDiffChunkProps = {
  /** The start line of the old content (start from 0, inclusive). */
  oldStart: number;
  /** The end line of the old content (start from 0, exclusive). */
  oldEnd: number;
  /**
   * The old content to be replaced by newLines.
   * If you know the full content of the old file as `allLines`, you
   * can also use `allLines.slice(oldStart, oldEnd)` to get this.
   */
  oldLines: List<string>;
  /** The start line of the new content (start from 0, inclusive). */
  newStart: number;
  /** The end line of the new content (start from 0, exclusive). */
  newEnd: number;
  /** The new content to replace oldLines. */
  newLines: List<string>;
  /**
   * Which rev introduces the "old" chunk.
   * The following revs are expected to contain this chunk too.
   * This is usually the "blame" rev in the stack.
   */
  introductionRev: Rev;
  /**
   * File revision (starts from 0) that the diff chunk is currently
   * selected to apply to. `null`: no selectioin.
   * Initially, this is the "suggested" rev to absorb to. Later,
   * the user can change this to a different rev.
   * Must be >= introductionRev.
   */
  selectedRev: Rev | null;
  /** The "AbsorbEditId" associated with this diff chunk. */
  absorbEditId?: AbsorbEditId;
};

export const AbsorbDiffChunk = Record<AbsorbDiffChunkProps>({
  oldStart: 0,
  oldEnd: 0,
  oldLines: List(),
  newStart: 0,
  newEnd: 0,
  newLines: List(),
  introductionRev: 0,
  selectedRev: null,
  absorbEditId: undefined,
});
export type AbsorbDiffChunk = RecordOf<AbsorbDiffChunkProps>;

/**
 * "Edit" id to distinguish different chunk edits.
 * Note a diff chunk might be split into multiple edits.
 */
export type AbsorbEditId = number;

/**
 * Maximum `AbsorbEditId` (exclusive). Must be an exponent of 2.
 *
 * Practically this shares the 52 bits (defined by IEEE 754) with the integer
 * part of the `Rev`.
 */
// eslint-disable-next-line no-bitwise
const MAX_ABSORB_EDIT_ID = 1 << 20;
const ABSORB_EDIT_ID_FRACTIONAL_UNIT = 1 / MAX_ABSORB_EDIT_ID;

/** Extract the "AbsorbEditId" from a linelog Rev */
export function extractRevAbsorbId(rev: Rev): [Rev, AbsorbEditId] {
  const fractional = rev % 1;
  const integerRev = rev - fractional;
  const absorbEditId = fractional / ABSORB_EDIT_ID_FRACTIONAL_UNIT - 1;
  assert(
    Number.isInteger(absorbEditId) && absorbEditId >= 0,
    `${rev} does not contain valid AbsorbEditId`,
  );
  return [integerRev, absorbEditId];
}

/** Embed an absorbEditId into a Rev */
export function embedAbsorbId(rev: Rev, absorbEditId: AbsorbEditId): Rev {
  assert(Number.isInteger(rev), `${rev} already has an absorbEditId embedded`);
  assert(
    absorbEditId < MAX_ABSORB_EDIT_ID - 1,
    `absorbEditId (${absorbEditId}) must be < MAX_ABSORB_EDIT_ID - 1 (${MAX_ABSORB_EDIT_ID} - 1)`,
  );
  return rev + ABSORB_EDIT_ID_FRACTIONAL_UNIT * (absorbEditId + 1);
}

/**
 * Returns a rev with all absorb edits for this rev included.
 * For example, `revWithAbsorb(2)` might return something like `2.999`.
 * */
export function revWithAbsorb(rev: Rev): Rev {
  return Math.floor(rev) + 1 - ABSORB_EDIT_ID_FRACTIONAL_UNIT;
}

/**
 * Calculate absorb edits for a stack.
 *
 * The stack top is treated as `wdir()` to be absorbed to the rest of the
 * stack. The stack bottom is treated as imutable `public()`.
 *
 * All edits in `wdir()` will be broken down and labeled with `AbsorbEditId`s.
 * If an edit with `id: AbsorbEditId` has a default absorb destination
 * `x: Rev`, then this edit will be inserted in linelog as rev
 * `embedAbsorbId(x, id)`, and can be checked out via
 * `linelog.checkOut(revWithAbsorb(x))`.
 *
 * If an edit has no default destination, for example, the surrounding lines
 * belong to public commit (rev 0), the edit will be left in the `wdir()`,
 * and can be checked out using `revWithAbsorb(wdirRev)`, where `wdirRev` is
 * the max integer rev in the linelog.
 *
 * Returns `FileStackState` with absorb edits embedded in the linelog, along
 * with a mapping from the `AbsorbEditId` to the diff chunk.
 */
export function calculateAbsorbEditsForFileStack(
  stack: FileStackState,
): [FileStackState, ImMap<AbsorbEditId, AbsorbDiffChunk>] {
  // rev 0 (public), 1, 2, ..., wdirRev-1 (stack top to absorb), wdirRev (wdir virtual rev)
  const wdirRev = stack.revLength - 1;
  assert(
    wdirRev >= 1,
    'calculateAbsorbEditsForFileStack requires at least one wdir(), one public()',
  );
  const newText = stack.getRev(wdirRev);
  const stackTopRev = wdirRev - 1;
  const diffChunks = analyseFileStack(stack, newText, stackTopRev);
  // Drop wdirRev, then re-insert the chunks.
  let newStack = stack.truncate(wdirRev);
  // Assign absorbEditId to each chunk.
  let nextAbsorbId = 0;
  let absorbIdToDiffChunk = ImMap<AbsorbEditId, AbsorbDiffChunk>();
  const diffChunksWithAbsorbId = diffChunks.map(chunk => {
    const absorbEditId = nextAbsorbId;
    const newChunk = chunk.set('absorbEditId', absorbEditId);
    absorbIdToDiffChunk = absorbIdToDiffChunk.set(absorbEditId, newChunk);
    nextAbsorbId += 1;
    return newChunk;
  });
  // Re-insert the chunks with the absorbId.
  newStack = applyFileStackEditsWithAbsorbId(newStack, diffChunksWithAbsorbId);
  return [newStack, absorbIdToDiffChunk];
}

/**
 * Given a stack and the latest changes (usually at the stack top),
 * calculate the diff chunks and the revs that they might be absorbed to.
 * The rev 0 of the file stack should come from a "public" (immutable) commit.
 */
export function analyseFileStack(
  stack: FileStackState,
  newText: string,
  stackTopRev?: Rev,
): List<AbsorbDiffChunk> {
  assert(stack.revLength > 0, 'stack should not be empty');
  const linelog = stack.convertToLineLog();
  const oldRev = stackTopRev ?? stack.revLength - 1;
  const oldText = stack.getRev(oldRev);
  const oldLines = splitLines(oldText);
  // The `LineInfo` contains "blame" information.
  const oldLineInfos = linelog.checkOutLines(oldRev);
  const newLines = splitLines(newText);
  const result: Array<AbsorbDiffChunk> = [];
  diffLines(oldLines, newLines).forEach(([a1, a2, b1, b2]) => {
    // a1, a2: line numbers in the `oldRev`.
    // b1, b2: line numbers in `newText`.
    // See also [`_analysediffchunk`](https://github.com/facebook/sapling/blob/6f29531e83daa62d9bd3bc58b712755d34f41493/eden/scm/sapling/ext/absorb/__init__.py#L346)
    let involvedLineInfos = oldLineInfos.slice(a1, a2);
    if (involvedLineInfos.length === 0 && oldLineInfos.length > 0) {
      // This is an insertion. Check the surrounding lines, excluding lines from the public commit.
      const nearbyLineNumbers = dedup([a2, Math.max(0, a1 - 1)]);
      involvedLineInfos = nearbyLineNumbers.map(i => oldLineInfos[i]);
    }
    // Check the revs. Skip public commits. The Python implementation only skips public
    // for insertions. Here we aggressively skip public lines for modification and deletion too.
    const involvedRevs = dedup(involvedLineInfos.map(info => info.rev).filter(rev => rev > 0));
    if (involvedRevs.length === 1) {
      // Only one rev. Set selectedRev to this.
      // For simplicity, we're not checking the "continuous" lines here yet (different from Python).
      const introductionRev = involvedRevs[0];
      result.push(
        AbsorbDiffChunk({
          oldStart: a1,
          oldEnd: a2,
          oldLines: List(oldLines.slice(a1, a2)),
          newStart: b1,
          newEnd: b2,
          newLines: List(newLines.slice(b1, b2)),
          introductionRev,
          selectedRev: introductionRev,
        }),
      );
    } else if (b1 === b2) {
      // Deletion. Break the chunk into sub-chunks with different selectedRevs.
      // For simplicity, we're not checking the "continuous" lines here yet (different from Python).
      splitChunk(a1, a2, oldLineInfos, (oldStart, oldEnd, introductionRev) => {
        result.push(
          AbsorbDiffChunk({
            oldStart,
            oldEnd,
            oldLines: List(oldLines.slice(oldStart, oldEnd)),
            newStart: b1,
            newEnd: b2,
            newLines: List([]),
            introductionRev,
            selectedRev: introductionRev,
          }),
        );
      });
    } else if (a2 - a1 === b2 - b1 && involvedLineInfos.some(info => info.rev > 0)) {
      // Line count matches on both side. No public lines.
      // We assume the "a" and "b" sides are 1:1 mapped.
      // So, even if the "a"-side lines blame to different revs, we can
      // still break the chunks to individual lines.
      const delta = b1 - a1;
      splitChunk(a1, a2, oldLineInfos, (oldStart, oldEnd, introductionRev) => {
        const newStart = oldStart + delta;
        const newEnd = oldEnd + delta;
        result.push(
          AbsorbDiffChunk({
            oldStart,
            oldEnd,
            oldLines: List(oldLines.slice(oldStart, oldEnd)),
            newStart,
            newEnd,
            newLines: List(newLines.slice(newStart, newEnd)),
            introductionRev,
            selectedRev: introductionRev === 0 ? null : introductionRev,
          }),
        );
      });
    } else {
      // Other cases, like replacing 10 lines from 3 revs to 20 lines.
      // It might be possible to build extra fancy UIs to support it
      // asking the user which sub-chunk on the "a" side matches which
      // sub-chunk on the "b" side.
      // For now, we just report this chunk as a whole chunk that can
      // only be absorbed to the "max" rev where the left side is
      // "settled" down.
      result.push(
        AbsorbDiffChunk({
          oldStart: a1,
          oldEnd: a2,
          oldLines: List(oldLines.slice(a1, a2)),
          newStart: b1,
          newEnd: b2,
          newLines: List(newLines.slice(b1, b2)),
          introductionRev: Math.max(0, ...involvedRevs),
          selectedRev: null,
        }),
      );
    }
  });
  return List(result);
}

/**
 * Apply edits specified by `chunks`.
 * Each `chunk` can specify which rev it wants to absorb to by setting `selectedRev`.
 */
export function applyFileStackEdits(
  stack: FileStackState,
  chunks: Iterable<AbsorbDiffChunk>,
): FileStackState {
  // See also [apply](https://github.com/facebook/sapling/blob/6f29531e83daa62d9bd3bc58b712755d34f41493/eden/scm/sapling/ext/absorb/__init__.py#L321)
  assert(stack.revLength > 0, 'stack should not be empty');
  let linelog = stack.convertToLineLog();
  // Remap revs from rev to rev * 2. So we can edit rev * 2 + 1 to override contents.
  linelog = linelog.remapRevs(new Map(Array.from({length: stack.revLength}, (_, i) => [i, i * 2])));
  const oldRev = stack.revLength - 1;
  // Apply the changes. Assuming there are no overlapping chunks, we apply
  // from end to start so the line numbers won't need change.
  const sortedChunks = [...chunks]
    .filter(c => c.selectedRev != null)
    .toSorted((a, b) => b.oldEnd - a.oldEnd);
  sortedChunks.forEach(chunk => {
    const targetRev = nullthrows(chunk.selectedRev);
    assert(
      targetRev >= chunk.introductionRev,
      `selectedRev ${targetRev} must be >= introductionRev ${chunk.introductionRev}`,
    );
    assert(
      targetRev > 0,
      'selectedRev must be > 0 since rev 0 is from the immutable public commit',
    );
    // Edit the content of a past revision (targetRev, and follow-ups) from a
    // future revision (oldRev, matches the line numbers).
    linelog = linelog.editChunk(
      oldRev * 2,
      chunk.oldStart,
      chunk.oldEnd,
      targetRev * 2 + 1,
      chunk.newLines.toArray(),
    );
  });
  const texts = Array.from({length: stack.revLength}, (_, i) => linelog.checkOut(i * 2 + 1));
  return new FileStackState(texts);
}

/**
 * Apply edits specified by `chunks`.
 * The `chunk.selectedRev` is expected to include the `AbsorbEditId`.
 */
function applyFileStackEditsWithAbsorbId(
  stack: FileStackState,
  chunks: Iterable<AbsorbDiffChunk>,
): FileStackState {
  assert(stack.revLength > 0, 'stack should not be empty');
  let linelog = stack.convertToLineLog();
  const wdirRev = stack.revLength;
  const stackTopRev = wdirRev - 1;
  // Apply the changes. Assuming there are no overlapping chunks, we apply
  // from end to start so the line numbers won't need change.
  const sortedChunks = [...chunks].toSorted((a, b) => b.oldEnd - a.oldEnd);
  sortedChunks.forEach(chunk => {
    // If not "selected" to amend to a commit, leave the chunk at the wdir.
    const baseRev = chunk.selectedRev ?? wdirRev;
    const absorbEditId = nullthrows(chunk.absorbEditId);
    const targetRev = embedAbsorbId(baseRev, absorbEditId);
    assert(
      targetRev >= chunk.introductionRev,
      `selectedRev ${targetRev} must be >= introductionRev ${chunk.introductionRev}`,
    );
    assert(
      targetRev > 0,
      'selectedRev must be > 0 since rev 0 is from the immutable public commit',
    );
    // Edit the content of a past revision (targetRev, and follow-ups) from a
    // future revision (oldRev, matches the line numbers).
    linelog = linelog.editChunk(
      stackTopRev,
      chunk.oldStart,
      chunk.oldEnd,
      targetRev,
      chunk.newLines.toArray(),
    );
  });
  return stack.fromLineLog(linelog);
}

/** Split the start..end chunk into sub-chunks so each chunk has the same "blame" rev. */
function splitChunk(
  start: number,
  end: number,
  lineInfos: readonly LineInfo[],
  callback: (_start: number, _end: number, _introductionRev: Rev) => void,
) {
  let lastStart = start;
  for (let i = start; i < end; i++) {
    const introductionRev = lineInfos[i].rev;
    if (i + 1 === end || introductionRev != lineInfos[i + 1].rev) {
      callback(lastStart, i + 1, introductionRev);
      lastStart = i + 1;
    }
  }
}
