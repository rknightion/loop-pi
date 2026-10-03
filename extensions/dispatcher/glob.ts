// Path-glob algebra for the dispatcher: do two owned-file globs overlap, does a glob touch the
// guarded set, is a split subtask's glob inside its parent's owned files.
//
// Globs are repo-relative: `*` and `?` stop at `/`, `**` crosses it, `**/` also matches no
// directory, `[...]` is one non-slash character, `{a,b}` expands. Overlap is exact for that
// grammar: it walks the product of the two patterns' automata, so `src/**` and `**/auth/**`
// overlap (src/auth/x) while `src/a/**` and `src/b/**` do not.

type Elem =
  | { k: "lit"; c: string }
  | { k: "one" } // ? or [...]: one non-slash character
  | { k: "star" } // * : any run of non-slash characters
  | { k: "dstar" } // ** not followed by / : any run of characters
  | { k: "dirs" }; // **/ : no directory, or any run of characters ending in /

type Label = { k: "lit"; c: string } | { k: "nonslash" } | { k: "any" };
type State = { i: number; inside: boolean };

function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open < 0) return [glob];
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}" && --depth === 0) {
      const body = glob.slice(open + 1, i);
      const parts: string[] = [];
      let level = 0;
      let start = 0;
      for (let j = 0; j < body.length; j++) {
        if (body[j] === "{") level++;
        else if (body[j] === "}") level--;
        else if (body[j] === "," && level === 0) {
          parts.push(body.slice(start, j));
          start = j + 1;
        }
      }
      parts.push(body.slice(start));
      const rest = glob.slice(i + 1);
      return parts.flatMap((part) => expandBraces(glob.slice(0, open) + part + rest));
    }
  }
  return [glob];
}

function compile(glob: string): Elem[] {
  const out: Elem[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      while (glob[i + 1] === "*") i++;
      if (glob[i + 1] === "/") {
        i++;
        out.push({ k: "dirs" });
      } else {
        out.push({ k: "dstar" });
      }
    } else if (c === "*") {
      out.push({ k: "star" });
    } else if (c === "?") {
      out.push({ k: "one" });
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close < 0) out.push({ k: "lit", c });
      else {
        out.push({ k: "one" });
        i = close;
      }
    } else if (c === "\\" && i + 1 < glob.length) {
      out.push({ k: "lit", c: glob[++i] });
    } else {
      out.push({ k: "lit", c });
    }
  }
  return out;
}

function literal(path: string): Elem[] {
  return [...path].map((c) => ({ k: "lit", c }) as Elem);
}

function closure(p: Elem[], s: State): State[] {
  const out: State[] = [s];
  let cur = s;
  while (!cur.inside && cur.i < p.length && p[cur.i].k !== "lit" && p[cur.i].k !== "one") {
    cur = { i: cur.i + 1, inside: false };
    out.push(cur);
  }
  return out;
}

function moves(p: Elem[], s: State): [Label, State][] {
  if (s.i >= p.length) return [];
  const e = p[s.i];
  switch (e.k) {
    case "lit":
      return [[{ k: "lit", c: e.c }, { i: s.i + 1, inside: false }]];
    case "one":
      return [[{ k: "nonslash" }, { i: s.i + 1, inside: false }]];
    case "star":
      return [[{ k: "nonslash" }, s]];
    case "dstar":
      return [[{ k: "any" }, s]];
    case "dirs":
      return [
        [{ k: "any" }, { i: s.i, inside: true }],
        [{ k: "lit", c: "/" }, { i: s.i + 1, inside: false }],
      ];
  }
}

function meet(a: Label, b: Label): boolean {
  if (a.k === "lit" && b.k === "lit") return a.c === b.c;
  if (a.k === "lit") return b.k === "any" || a.c !== "/";
  if (b.k === "lit") return a.k === "any" || b.c !== "/";
  return true;
}

function intersectsCompiled(a: Elem[], b: Elem[]): boolean {
  const key = (x: State, y: State) => `${x.i},${x.inside ? 1 : 0},${y.i},${y.inside ? 1 : 0}`;
  const seen = new Set<string>();
  const queue: [State, State][] = [];
  const push = (x: State, y: State) => {
    for (const cx of closure(a, x)) {
      for (const cy of closure(b, y)) {
        const k = key(cx, cy);
        if (!seen.has(k)) {
          seen.add(k);
          queue.push([cx, cy]);
        }
      }
    }
  };
  push({ i: 0, inside: false }, { i: 0, inside: false });
  while (queue.length) {
    const [x, y] = queue.shift()!;
    if (x.i === a.length && y.i === b.length && !x.inside && !y.inside) return true;
    for (const [la, nx] of moves(a, x)) {
      for (const [lb, ny] of moves(b, y)) {
        if (meet(la, lb)) push(nx, ny);
      }
    }
  }
  return false;
}

/** Normalises an owned-files entry: strips `./` and leading `/`; `dir/` means everything under it.
 *  A bare entry is a file, as the goal format says owned files are globs. */
export function ownedPatterns(entry: string): string[] {
  const glob = entry.trim().replace(/^`|`$/g, "").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!glob) return [];
  return [glob.endsWith("/") ? `${glob}**` : glob];
}

/** True when some path matches both globs. */
export function globsIntersect(a: string, b: string): boolean {
  for (const x of expandBraces(a)) {
    for (const y of expandBraces(b)) {
      if (intersectsCompiled(compile(x), compile(y))) return true;
    }
  }
  return false;
}

/** True when the repo-relative path matches the glob. */
export function globMatch(path: string, glob: string): boolean {
  return expandBraces(glob).some((g) => intersectsCompiled(literal(path), compile(g)));
}

/** True when any glob of one owned list overlaps any glob of the other. */
export function ownedOverlap(a: readonly string[], b: readonly string[]): boolean {
  const pa = a.flatMap(ownedPatterns);
  const pb = b.flatMap(ownedPatterns);
  return pa.some((x) => pb.some((y) => globsIntersect(x, y)));
}

/** S4's built-in guarded set. `**\/*.sql` stands for "SQL with DROP or DELETE": the dispatcher
 *  cannot read a file a lane has not written yet, so every SQL file counts. */
export const BUILTIN_GUARDED: readonly string[] = [
  "**/auth/**",
  "**/*auth*.*",
  "**/*secret*",
  "**/*credential*",
  "**/migrations/**",
  "**/*.sql",
  "**/*.tf",
  "**/terraform/**",
  "**/iac/**",
  "**/k8s/**",
  "**/helm/**",
  ".github/workflows/**",
  "release-please-config.json",
  ".release-please-manifest.json",
  "**/deploy/**",
  "wrangler.toml",
  "wrangler.jsonc",
];

/** A guarded glob without a slash names that file anywhere in the tree. */
function guardedPattern(glob: string): string {
  const g = glob.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  return g.includes("/") ? g : `**/${g}`;
}

/** The guarded globs the owned list touches (built-in set plus LOOP.md `guarded-paths`). An owned
 *  glob touches a guarded glob when the glob's own text, read as a path, matches it (`src/auth/**`,
 *  `deploy.tf`, each brace alternative separately), or when a repository file it matches also matches it. Plain glob overlap is not
 *  used: every `**` glob overlaps `**\/auth/**`. */
export function guardedHits(owned: readonly string[], extraGuarded: readonly string[] = [], files: readonly string[] = []): string[] {
  const patterns = owned.flatMap(ownedPatterns);
  const touched = files.filter((f) => patterns.some((p) => globMatch(f, p)));
  // Read each brace alternative as its own path, so `src/{auth,util}/**` is checked as `src/auth/**`.
  const literals = patterns.flatMap(expandBraces);
  return [...BUILTIN_GUARDED, ...extraGuarded]
    .filter((g) => g.trim())
    .filter((g) => {
      const guard = guardedPattern(g);
      return literals.some((p) => globMatch(p, guard)) || touched.some((f) => globMatch(f, guard));
    });
}

/** Approximate containment for a split subtask: the child glob, read literally and with its
 *  wildcards filled in, must match one parent glob. */
export function ownedWithin(child: string, parent: readonly string[]): boolean {
  const parents = parent.flatMap(ownedPatterns);
  return ownedPatterns(child).every((c) => {
    const probes = [c, c.replace(/\*\*/g, "p/q").replace(/\*/g, "p").replace(/\?/g, "p")];
    return parents.some((p) => probes.every((probe) => globMatch(probe, p)));
  });
}
