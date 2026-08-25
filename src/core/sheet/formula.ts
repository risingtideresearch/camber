// ---------- the weight sheet's formula language ----------
//
// A tokenizer, a Pratt parser and an evaluator over `Quantity`. Small on purpose: this is arithmetic with
// references, uncertainty literals and a handful of functions — not a spreadsheet engine.
//
// It is written rather than taken off the shelf because the interesting half is the VALUE TYPE. HyperFormula
// is a grid engine (and GPL-or-commercial); formulajs and mathjs both fix the value at `number`. Every one of
// them would need the uncertainty and the dimensions bolted on top of a type we do not control, which is more
// work than the ~300 lines below and leaves us unable to change the thing that matters.
//
// ---------- the grammar ----------
//
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/') unary)*
//   unary   := '-' unary | power
//   power   := primary ('^' unary)?           -- right associative, so 2^3^2 is 2^(3^2)
//   primary := number spread? '%'?
//            | range
//            | name ('.' name)* ('(' args ')')?
//            | '(' expr ')'
//   spread  := ('±' | '+-') (amount | '[' amount ',' amount ']')
//   amount  := number '%'?
//   range   := '[' number ',' number ']'
//
// A leading minus applies AFTER the power, so `-2^2` is −4: the mathematical convention, and what nearly
// every programming language does. Excel answers 4 here. This is not a spreadsheet, and following Excel on a
// point where it disagrees with arithmetic would be a poor trade.
//
// Uncertainty is written where the number is, and only on a NUMBER — `2 * 3 ± 1` is `2 * (3 ± 1)`, which is
// what anyone typing it means. The three forms:
//
//   4.2 ± 0.3          symmetric, absolute
//   4.2 ± 5%           symmetric, relative to the 4.2
//   4.2 ± [0.2, 0.5]   asymmetric: 0.2 below, 0.5 above (the lightship is known, the gear is not)
//   [4.0, 4.5]         a bare range, whose nominal is the midpoint
//
// `%` outside a spread is an ordinary postfix meaning ÷100, so `7%` is 0.07 and a margin reads as
// `total * 7%`. Inside a spread it means "of the nominal", which is the only place the two differ.
//
// ---------- names with spaces ----------
//
// `hull shell` is a better name than `hull_shell`, and a weight schedule is full of them. The lexer takes
// them because it is given the SYMBOL TABLE — every name currently in scope, longest first — and tries those
// before falling back to scanning a bare identifier.
//
// That is only unambiguous because the language has no implicit multiplication. Two names side by side could
// never have meant anything else, so taking the longest match cannot swallow an operation the user intended;
// the worst it can do is prefer `shell area` where both `shell` and `shell area` exist, which is the right
// answer anyway. Without a table the lexer scans identifiers as it always did, which is what keeps
// `parseFormula` usable from a test with no book to hand.

import {
  abs,
  add,
  cos,
  div,
  exact,
  exp,
  ln,
  log10,
  maxOf,
  minOf,
  mul,
  neg,
  pow,
  QuantityError,
  sin,
  sqrt,
  sub,
  tan,
  type Quantity,
  type Source,
} from "./quantity";

export class FormulaError extends Error {
  /** Character offset the trouble was found at, for a caret under the input. */
  constructor(
    message: string,
    readonly at: number = -1,
  ) {
    super(message);
  }
}

// ---------- tokens ----------

type TokKind =
  | "num"
  | "name"
  | "op"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "comma"
  | "dot"
  | "percent"
  | "plusminus"
  | "end";

interface Token {
  readonly kind: TokKind;
  readonly text: string;
  readonly value: number;
  readonly at: number;
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isNameStart = (c: string): boolean =>
  (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const isNameChar = (c: string): boolean => isNameStart(c) || isDigit(c);

export function tokenize(
  source: string,
  symbols: readonly string[] = [],
): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (kind: TokKind, text: string, at: number, value = 0) =>
    out.push({ kind, text, value, at });

  // The longest known name starting here, or null. A match has to END on a boundary too, or `shell` would be
  // taken out of `shellac`.
  //
  // Matched case-INSENSITIVELY, and the token carries what the user actually typed. That is what lets
  // `Shell Area` become one name token and then fail to RESOLVE — with "did you mean shell area?" — instead
  // of failing to lex, which would report a syntax error about a space and help nobody. Resolution itself
  // stays case-sensitive: two rows differing only in case are two rows.
  const lower = source.toLowerCase();
  const knownNameAt = (at: number): string | null => {
    for (const name of symbols) {
      if (!lower.startsWith(name.toLowerCase(), at)) continue;
      const after = source[at + name.length];
      if (after !== undefined && isNameChar(after)) continue;
      return source.slice(at, at + name.length);
    }
    return null;
  };

  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // The ASCII spelling of ± is accepted because typing the real one is a nuisance on most keyboards. It has
    // to be tested before the `+` operator, or `+-0.3` would lex as a plus followed by a negation.
    if (c === "±" || (c === "+" && source[i + 1] === "-")) {
      push("plusminus", c === "±" ? "±" : "+-", i);
      i += c === "±" ? 1 : 2;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      const start = i;
      while (i < source.length && isDigit(source[i])) i++;
      if (source[i] === ".") {
        i++;
        while (i < source.length && isDigit(source[i])) i++;
      }
      if (source[i] === "e" || source[i] === "E") {
        const save = i;
        i++;
        if (source[i] === "+" || source[i] === "-") i++;
        if (isDigit(source[i] ?? ""))
          while (i < source.length && isDigit(source[i])) i++;
        else i = save;
      }
      const text = source.slice(start, i);
      push("num", text, start, Number(text));
      continue;
    }
    if (isNameStart(c)) {
      const known = knownNameAt(i);
      if (known) {
        push("name", known, i);
        i += known.length;
        continue;
      }
      const start = i;
      while (i < source.length && isNameChar(source[i])) i++;
      push("name", source.slice(start, i), start);
      continue;
    }
    const simple: Record<string, TokKind> = {
      "(": "lparen",
      ")": "rparen",
      "[": "lbracket",
      "]": "rbracket",
      ",": "comma",
      ".": "dot",
      "%": "percent",
    };
    if (simple[c]) {
      push(simple[c], c, i);
      i++;
      continue;
    }
    if ("+-*/^".includes(c)) {
      push("op", c, i);
      i++;
      continue;
    }
    // A multiplication sign or a minus typed from a word processor, which is easy to paste in by accident.
    if (c === "×") {
      push("op", "*", i);
      i++;
      continue;
    }
    if (c === "−" || c === "–") {
      push("op", "-", i);
      i++;
      continue;
    }
    throw new FormulaError(`I do not know what to do with "${c}"`, i);
  }
  push("end", "", source.length);
  return out;
}

// ---------- the tree ----------

export type Node =
  | { readonly k: "num"; readonly v: number }
  /** A number with an uncertainty attached. `lo`/`hi` are already absolute by the time they get here. */
  | {
      readonly k: "spread";
      readonly v: number;
      readonly lo: number;
      readonly hi: number;
      readonly at: number;
    }
  /** A dotted path: `hull shell`, `HULL.WSA`, `Weights.hull shell`. */
  | { readonly k: "ref"; readonly path: readonly string[]; readonly at: number }
  | {
      readonly k: "call";
      readonly name: string;
      readonly args: readonly Node[];
      readonly at: number;
    }
  | { readonly k: "neg"; readonly a: Node }
  | { readonly k: "pct"; readonly a: Node }
  | {
      readonly k: "bin";
      readonly op: "+" | "-" | "*" | "/" | "^";
      readonly a: Node;
      readonly b: Node;
      readonly at: number;
    };

// ---------- the parser ----------

class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.pos];
  }
  private next(): Token {
    return this.toks[this.pos++];
  }
  private eat(kind: TokKind, text?: string): Token | null {
    const tok = this.peek();
    if (tok.kind !== kind) return null;
    if (text !== undefined && tok.text !== text) return null;
    this.pos++;
    return tok;
  }
  private expect(kind: TokKind, what: string): Token {
    const tok = this.peek();
    if (tok.kind !== kind)
      throw new FormulaError(
        `expected ${what}${tok.kind === "end" ? " but the formula ended" : ` but found "${tok.text}"`}`,
        tok.at,
      );
    this.pos++;
    return tok;
  }

  parse(): Node {
    const node = this.expr();
    const rest = this.peek();
    if (rest.kind !== "end")
      throw new FormulaError(`"${rest.text}" is not expected here`, rest.at);
    return node;
  }

  private expr(): Node {
    let a = this.term();
    for (;;) {
      const tok = this.peek();
      if (tok.kind !== "op" || (tok.text !== "+" && tok.text !== "-")) return a;
      this.next();
      a = {
        k: "bin",
        op: tok.text as "+" | "-",
        a,
        b: this.term(),
        at: tok.at,
      };
    }
  }

  private term(): Node {
    let a = this.unary();
    for (;;) {
      const tok = this.peek();
      if (tok.kind !== "op" || (tok.text !== "*" && tok.text !== "/")) return a;
      this.next();
      a = {
        k: "bin",
        op: tok.text as "*" | "/",
        a,
        b: this.unary(),
        at: tok.at,
      };
    }
  }

  private unary(): Node {
    const tok = this.peek();
    if (tok.kind === "op" && tok.text === "-") {
      this.next();
      return { k: "neg", a: this.unary() };
    }
    if (tok.kind === "op" && tok.text === "+") {
      this.next();
      return this.unary();
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    const tok = this.peek();
    if (tok.kind === "op" && tok.text === "^") {
      this.next();
      // Right associative, and the exponent may itself be negated: 2^-1.
      return { k: "bin", op: "^", a: base, b: this.unary(), at: tok.at };
    }
    return base;
  }

  /** One `amount` in a spread: a number, optionally a percentage of the nominal it hangs off. */
  private amount(nominal: number): number {
    const negate = this.eat("op", "-") ? -1 : (this.eat("op", "+"), 1);
    const num = this.expect("num", "a number");
    const value = num.value * negate;
    if (this.eat("percent")) return Math.abs(nominal) * (value / 100);
    return value;
  }

  private primary(): Node {
    const tok = this.peek();

    if (tok.kind === "lbracket") {
      // A bare range: its nominal is the midpoint, because nothing else was stated.
      this.next();
      const lo = this.expect("num", "the low end of the range");
      this.expect("comma", "a comma between the ends of the range");
      const hi = this.expect("num", "the high end of the range");
      this.expect("rbracket", "a closing ]");
      if (hi.value < lo.value)
        throw new FormulaError(
          "a range runs low to high — those are the wrong way round",
          lo.at,
        );
      const mid = (lo.value + hi.value) / 2;
      return this.maybePercent({
        k: "spread",
        v: mid,
        lo: mid - lo.value,
        hi: hi.value - mid,
        at: tok.at,
      });
    }

    if (tok.kind === "num") {
      this.next();
      if (this.eat("plusminus")) {
        if (this.eat("lbracket")) {
          const lo = this.amount(tok.value);
          this.expect("comma", "a comma between the two sides of the ±");
          const hi = this.amount(tok.value);
          this.expect("rbracket", "a closing ]");
          if (lo < 0 || hi < 0)
            throw new FormulaError(
              "both sides of a ± are distances, so neither is negative",
              tok.at,
            );
          return this.maybePercent({
            k: "spread",
            v: tok.value,
            lo,
            hi,
            at: tok.at,
          });
        }
        const amount = Math.abs(this.amount(tok.value));
        return this.maybePercent({
          k: "spread",
          v: tok.value,
          lo: amount,
          hi: amount,
          at: tok.at,
        });
      }
      return this.maybePercent({ k: "num", v: tok.value });
    }

    if (tok.kind === "lparen") {
      this.next();
      const inner = this.expr();
      this.expect("rparen", "a closing )");
      return this.maybePercent(inner);
    }

    if (tok.kind === "name") {
      this.next();
      const path = [tok.text];
      while (this.eat("dot"))
        path.push(this.expect("name", "a name after .").text);
      if (this.peek().kind === "lparen") {
        if (path.length > 1)
          throw new FormulaError(
            `"${path.join(".")}" is not a function`,
            tok.at,
          );
        this.next();
        const args: Node[] = [];
        if (this.peek().kind !== "rparen") {
          args.push(this.expr());
          while (this.eat("comma")) args.push(this.expr());
        }
        this.expect("rparen", "a closing )");
        return this.maybePercent({
          k: "call",
          name: path[0],
          args,
          at: tok.at,
        });
      }
      return this.maybePercent({ k: "ref", path, at: tok.at });
    }

    if (tok.kind === "end")
      throw new FormulaError("the formula stops here, unfinished", tok.at);
    throw new FormulaError(`"${tok.text}" is not expected here`, tok.at);
  }

  private maybePercent(node: Node): Node {
    return this.eat("percent") ? { k: "pct", a: node } : node;
  }
}

/**
 * Parse a formula. Throws `FormulaError`; the sheet turns that into a per-row message.
 *
 * `symbols` is every name in scope, longest first (see `symbolsOf`). Without it, names are scanned as bare
 * identifiers and a name with a space in it will not parse — which is right for a caller that has no book.
 */
export function parseFormula(
  source: string,
  symbols: readonly string[] = [],
): Node {
  return new Parser(tokenize(source, symbols)).parse();
}

// ---------- evaluation ----------

/**
 * What the evaluator needs from whoever owns the sheet.
 *
 * Keeping this an interface rather than passing the sheet in is what lets `formula.ts` know nothing about
 * rows, columns, groups or hulls: it resolves a dotted path by asking, and mints a source by asking.
 */
export interface EvalEnv {
  /** Resolve a dotted path to a value, or throw a `FormulaError` explaining what is missing. */
  resolve(path: readonly string[], at: number): Quantity;
  /**
   * Register a new independent uncertain input and return it. The env names it, because the useful name is
   * the ROW it was typed in — which is what makes the sensitivity list readable.
   */
  source(lo: number, hi: number): Source;
}

/** The functions a formula may call, with how many arguments each takes. */
export const FUNCTIONS: Record<
  string,
  { readonly arity: number | "any"; readonly hint: string }
> = {
  sqrt: { arity: 1, hint: "sqrt(x) — square root" },
  abs: { arity: 1, hint: "abs(x) — magnitude" },
  min: { arity: "any", hint: "min(a, b, …) — the smallest" },
  max: { arity: "any", hint: "max(a, b, …) — the largest" },
  exp: { arity: 1, hint: "exp(x) — e to the x" },
  ln: { arity: 1, hint: "ln(x) — natural logarithm" },
  log10: { arity: 1, hint: "log10(x)" },
  sin: { arity: 1, hint: "sin(deg) — degrees, not radians" },
  cos: { arity: 1, hint: "cos(deg) — degrees, not radians" },
  tan: { arity: 1, hint: "tan(deg) — degrees, not radians" },
};

export function evaluate(node: Node, env: EvalEnv): Quantity {
  // Every arithmetic rule can refuse (mismatched units, a division by zero), and those refusals arrive as
  // QuantityError. They are turned into FormulaError here so a caller has one error type to catch and a
  // position to point at.
  const guard = <T>(at: number, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof QuantityError)
        throw new FormulaError(error.message, at);
      throw error;
    }
  };

  switch (node.k) {
    case "num":
      return exact(node.v);

    case "spread":
      // A ± with no width is just a number. Not registering a source keeps the sensitivity list free of
      // entries that can never contribute anything.
      return node.lo === 0 && node.hi === 0
        ? exact(node.v)
        : {
            v: node.v,
            d: { [env.source(node.lo, node.hi).id]: 1 },
            dim: { m: 0, l: 0 },
          };

    case "ref":
      return env.resolve(node.path, node.at);

    case "neg":
      return neg(evaluate(node.a, env));

    case "pct":
      return guard(0, () => div(evaluate(node.a, env), exact(100)));

    case "bin": {
      const a = evaluate(node.a, env);
      const b = evaluate(node.b, env);
      return guard(node.at, () => {
        switch (node.op) {
          case "+":
            return add(a, b);
          case "-":
            return sub(a, b);
          case "*":
            return mul(a, b);
          case "/":
            return div(a, b);
          case "^":
            return pow(a, b);
        }
      });
    }

    case "call": {
      const spec = FUNCTIONS[node.name];
      if (!spec)
        throw new FormulaError(
          `there is no function called ${node.name}`,
          node.at,
        );
      const args = node.args.map((arg) => evaluate(arg, env));
      if (spec.arity !== "any" && args.length !== spec.arity)
        throw new FormulaError(
          `${node.name} takes ${spec.arity} argument${spec.arity === 1 ? "" : "s"}, not ${args.length}`,
          node.at,
        );
      if (spec.arity === "any" && args.length === 0)
        throw new FormulaError(
          `${node.name} needs something to work on`,
          node.at,
        );
      return guard(node.at, () => {
        switch (node.name) {
          case "sqrt":
            return sqrt(args[0]);
          case "abs":
            return abs(args[0]);
          case "min":
            return minOf(args);
          case "max":
            return maxOf(args);
          case "exp":
            return exp(args[0]);
          case "ln":
            return ln(args[0]);
          case "log10":
            return log10(args[0]);
          case "sin":
            return sin(args[0]);
          case "cos":
            return cos(args[0]);
          case "tan":
            return tan(args[0]);
          default:
            throw new FormulaError(
              `there is no function called ${node.name}`,
              node.at,
            );
        }
      });
    }
  }
}

/**
 * Every dotted path a formula mentions, in source order.
 *
 * This is what the sheet builds its dependency graph from, and it is deliberately a walk of the TREE rather
 * than of the text: a name inside a string or a comment could not be told apart otherwise, and a reference
 * the evaluator would never reach must not create an edge.
 */
export function referencesOf(node: Node): string[][] {
  const out: string[][] = [];
  const walk = (n: Node): void => {
    switch (n.k) {
      case "ref":
        out.push([...n.path]);
        return;
      case "neg":
      case "pct":
        walk(n.a);
        return;
      case "bin":
        walk(n.a);
        walk(n.b);
        return;
      case "call":
        n.args.forEach(walk);
        return;
      case "num":
      case "spread":
        return;
    }
  };
  walk(node);
  return out;
}
