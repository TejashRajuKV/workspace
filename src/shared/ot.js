// ============================================================
// TextOperation — Operational Transformation for collaborative text.
//
// Model (Jupiter / ShareJS / ot.js lineage):
//   An operation is a sequence of components applied left-to-right over the
//   current document string:
//     - positive number n  → retain next n characters
//     - string s           → insert s at the current position
//     - negative number -n → delete next n characters
//
//   Invariants enforced by construction:
//     - no two adjacent inserts (they would be mergeable)
//     - no two adjacent deletes
//     - inserts are normalized to appear BEFORE adjacent deletes
//     - retains are never zero-length
//     - baseLength   == length of the document the op applies to
//     - targetLength == length of the document after applying
//
//   transform(a, b) -> [a', b']:
//     apply(a) then apply(b')  ===  apply(b) then apply(a')
//   The insert-vs-insert tie-break uses lexicographic string comparison so
//   every peer derives the same result independently (deterministic).
//
// Dependency-free; shared verbatim between browser client and service.
// ============================================================

class TextOperation {
  constructor() {
    this.ops = [];
    this.baseLength = 0;
    this.targetLength = 0;
  }

  static isRetain(op) {
    return typeof op === "number" && op > 0;
  }
  static isInsert(op) {
    return typeof op === "string";
  }
  static isDelete(op) {
    return typeof op === "number" && op < 0;
  }

  retain(n) {
    if (n === 0) return this;
    this.baseLength += n;
    this.targetLength += n;
    const last = this.ops[this.ops.length - 1];
    if (TextOperation.isRetain(last)) {
      this.ops[this.ops.length - 1] = last + n;
    } else {
      this.ops.push(n);
    }
    return this;
  }

  insert(str) {
    if (!str) return this;
    this.targetLength += str.length;
    const ops = this.ops;
    const last = ops[ops.length - 1];
    if (TextOperation.isInsert(last)) {
      ops[ops.length - 1] = last + str;
    } else if (TextOperation.isDelete(last)) {
      // keep inserts before deletes
      if (TextOperation.isInsert(ops[ops.length - 2])) {
        ops[ops.length - 2] += str;
      } else {
        ops[ops.length] = ops[ops.length - 1]; // move delete to the end
        ops[ops.length - 2] = str; // insert where the delete was
      }
    } else {
      ops.push(str);
    }
    return this;
  }

  delete(n) {
    if (typeof n === "string") n = n.length;
    if (n === 0) return this;
    if (n > 0) n = -n;
    this.baseLength += -n;
    const last = this.ops[this.ops.length - 1];
    if (TextOperation.isDelete(last)) {
      this.ops[this.ops.length - 1] = last + n;
    } else {
      this.ops.push(n);
    }
    return this;
  }

  isNoop() {
    return (
      this.ops.length === 0 ||
      (this.ops.length === 1 &&
        typeof this.ops[0] === "number" &&
        this.ops[0] > 0)
    );
  }

  toJSON() {
    return this.ops.slice();
  }

  static fromJSON(ops) {
    const op = new TextOperation();
    for (const component of ops) {
      if (typeof component === "number") {
        if (component > 0) op.retain(component);
        else op.delete(-component);
      } else if (typeof component === "string") {
        op.insert(component);
      } else {
        throw new Error("unknown component: " + JSON.stringify(component));
      }
    }
    return op;
  }

  // Apply to a document string. Throws if the length doesn't match.
  apply(str) {
    if (str.length !== this.baseLength)
      throw new Error(
        `operation expects base length ${this.baseLength}, got ${str.length}`
      );
    const parts = [];
    let index = 0;
    for (const op of this.ops) {
      if (TextOperation.isRetain(op)) {
        parts.push(str.slice(index, index + op));
        index += op;
      } else if (TextOperation.isInsert(op)) {
        parts.push(op);
      } else {
        index += -op; // deleted characters are skipped
      }
    }
    return parts.join("");
  }

  // Build the inverse operation, given the document it applies to.
  invert(str) {
    let index = 0;
    const inverse = new TextOperation();
    for (const op of this.ops) {
      if (TextOperation.isRetain(op)) {
        inverse.retain(op);
        index += op;
      } else if (TextOperation.isInsert(op)) {
        inverse.delete(op.length);
      } else {
        inverse.insert(str.slice(index, index + -op));
        index += -op;
      }
    }
    return inverse;
  }

  // Compose: (a applied, then b applied) as one single operation.
  compose(b) {
    const a = this;
    if (a.targetLength !== b.baseLength)
      throw new Error("compose: targetLength != baseLength");

    const out = new TextOperation();
    const ops1 = a.ops;
    const ops2 = b.ops;
    let i1 = 0,
      i2 = 0;
    let op1 = ops1[i1++],
      op2 = ops2[i2++];
    let s = null; // pending insert string from a being matched against b

    const advance1 = () => (op1 = ops1[i1++]);
    const advance2 = () => (op2 = ops2[i2++]);

    while (true) {
      if (s === null && op1 === undefined && op2 === undefined) break;

      // a's base exhausted → b's remaining components cover a's inserted
      // text (retained pieces were emitted, deleted pieces vanish silently)
      if (s === null && op1 === undefined) {
        if (op2 === undefined) break;
        if (typeof op2 === "number") {
          advance2();
          continue;
        }
        // b inserting after all of a — append it
        out.insert(op2);
        advance2();
        continue;
      }
      if (op2 === undefined && s === null) {
        // b is exhausted; a may still have trailing deletes of base chars
        // that b never saw (they were already removed from doc2)
        if (op1 !== undefined && TextOperation.isDelete(op1)) {
          out.delete(-op1);
          advance1();
          continue;
        }
        throw new Error("compose: first op too long");
      }

      // 1. a deletes → the deletion passes through regardless of b
      if (s === null && TextOperation.isDelete(op1)) {
        out.delete(-op1);
        advance1();
        continue;
      }

      // 2. b inserts at the aligned position (before a's pending insert)
      if (TextOperation.isInsert(op2) && s === null) {
        out.insert(op2);
        advance2();
        continue;
      }

      // 3. a has an insert pending (possibly split against b's components)
      if (s === null && TextOperation.isInsert(op1)) {
        s = op1;
        advance1();
      }
      if (s !== null) {
        if (s === "") {
          s = null;
          continue;
        }
        if (TextOperation.isInsert(op2)) {
          // b inserts before a's pending inserted text
          out.insert(op2);
          advance2();
          continue;
        }
        if (TextOperation.isRetain(op2)) {
          // b retains part of a's inserted text → it survives
          const k = Math.min(s.length, op2);
          out.insert(s.slice(0, k));
          s = s.slice(k);
          op2 -= k;
          if (op2 === 0) advance2();
          continue;
        }
        if (TextOperation.isDelete(op2)) {
          // b deletes part of a's inserted text → it vanishes
          const k = Math.min(s.length, -op2);
          s = s.slice(k);
          op2 += k;
          if (op2 === 0) advance2();
          continue;
        }
        throw new Error("compose: unexpected component under insert");
      }

      // 4. numeric pairs (op1 is a retain here)
      let n;
      if (op1 > 0 && op2 > 0) {
        n = Math.min(op1, op2);
        out.retain(n);
        op1 -= n;
        op2 -= n;
      } else if (op1 > 0 && op2 < 0) {
        n = Math.min(op1, -op2);
        out.delete(n);
        op1 -= n;
        op2 += n;
      } else {
        throw new Error("compose: unexpected component pair");
      }
      if (op1 === 0) advance1();
      if (op2 === 0) advance2();
    }
    return out;
  }

  // Transform against a concurrent operation.
  // Returns [a', b'] where a' applies after b, and b' applies after a.
  static transform(a, b) {
    if (a.baseLength !== b.baseLength)
      throw new Error("transform: base lengths must match");

    const aPrime = new TextOperation();
    const bPrime = new TextOperation();
    const ops1 = a.ops;
    const ops2 = b.ops;
    let i1 = 0,
      i2 = 0;
    let op1 = ops1[i1++],
      op2 = ops2[i2++];

    while (true) {
      if (op1 === undefined && op2 === undefined) break;

      // One side's base is exhausted: the other side may still hold trailing
      // INSERT components (inserts don't consume base) — legal and common
      // (e.g. typing at the end of the document). Retains/deletes remaining
      // here would mean mismatched base lengths.
      if (op1 === undefined) {
        if (TextOperation.isInsert(op2)) {
          aPrime.retain(op2.length);
          bPrime.insert(op2);
          op2 = ops2[i2++];
          continue;
        }
        throw new Error("transform: cannot transform");
      }
      if (op2 === undefined) {
        if (TextOperation.isInsert(op1)) {
          aPrime.insert(op1);
          bPrime.retain(op1.length);
          op1 = ops1[i1++];
          continue;
        }
        throw new Error("transform: cannot transform");
      }

      // insert × insert: tie-break by lexicographic string comparison so the
      // result is independent of argument order (deterministic convergence)
      if (TextOperation.isInsert(op1) && TextOperation.isInsert(op2)) {
        if (op2 <= op1) {
          aPrime.retain(op2.length);
          bPrime.insert(op2);
          op2 = ops2[i2++];
        } else {
          aPrime.insert(op1);
          bPrime.retain(op1.length);
          op1 = ops1[i1++];
        }
        continue;
      }

      // single-sided insert applies first
      if (TextOperation.isInsert(op1)) {
        aPrime.insert(op1);
        bPrime.retain(op1.length);
        op1 = ops1[i1++];
        continue;
      }
      if (TextOperation.isInsert(op2)) {
        aPrime.retain(op2.length);
        bPrime.insert(op2);
        op2 = ops2[i2++];
        continue;
      }

      let n;
      if (op1 > 0 && op2 > 0) {
        // retain × retain
        n = Math.min(op1, op2);
        aPrime.retain(n);
        bPrime.retain(n);
        op1 -= n;
        op2 -= n;
      } else if (op1 < 0 && op2 < 0) {
        // delete × delete → the text is gone; neither prime deletes again
        n = Math.min(-op1, -op2);
        op1 += n;
        op2 += n;
      } else if (op1 < 0 && op2 > 0) {
        // a deletes text b retained → a' still deletes it, b' skips it
        n = Math.min(-op1, op2);
        aPrime.delete(n);
        op1 += n;
        op2 -= n;
      } else {
        // a retains text b deletes → b' still deletes it, a' skips it
        n = Math.min(op1, -op2);
        bPrime.delete(n);
        op1 -= n;
        op2 += n;
      }
      if (op1 === 0) op1 = ops1[i1++];
      if (op2 === 0) op2 = ops2[i2++];
    }
    return [aPrime, bPrime];
  }
}

// Transform a caret/selection offset through an operation.
//
// `position` is an offset in the document the operation applies to (base);
// the result is the offset in the document after the operation (target).
//   - inserts strictly before the caret shift it (and at the same position
//     when `ownInsert` is true — used for the local user's own typing)
//   - a caret inside a deleted span clamps to the span's start
export function transformPosition(position, operation, ownInsert = false) {
  let base = position; // base-document chars remaining until the caret
  let target = position; // transformed offset
  for (const op of operation.ops) {
    if (base < 0) break; // already passed the caret
    if (TextOperation.isRetain(op)) {
      base -= op;
    } else if (TextOperation.isInsert(op)) {
      if (base > 0 || (base === 0 && ownInsert)) target += op.length;
    } else {
      const del = -op;
      if (base >= del) {
        target -= del;
        base -= del;
      } else {
        // caret sits inside the deleted span → clamp to its start
        target -= base;
        base = -1;
        break;
      }
    }
  }
  return Math.max(0, target);
}

export default TextOperation;
