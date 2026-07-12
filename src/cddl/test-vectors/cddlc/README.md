# cddlc CDDL corpus

CDDL files in `data/` and `test/` are copied locally from
[cabo/cddlc](https://github.com/cabo/cddlc) (MIT license) and are used for
optional integration testing of the CDDL parser:

- `data/*.cddl` — real-world CDDL modules extracted from published RFCs
  (COSE, SUIT, CoSWID, EDHOC, …), plus the RFC 8610 Appendix D standard
  prelude (`prelude.cddl`).
- `test/*.cddl` — small feature-focused cases from the cddlc test suite.
  Many embed validation vectors as `;;+ <EDN>` (must validate) /
  `;;- <EDN>` (must not) / `;;: <EDN>` (continuation) comment lines,
  driven by `cddl-validation-vectors.test.ts`.

Every file must parse, survive a format → re-parse round trip with an
identical AST, and compile with `strict: false` (standalone RFC modules may
legitimately reference names defined in other modules, so undefined-name
warnings are allowed; syntax errors are not).

The files are not committed to this repository; only this README and the
test driver are tracked.

## Running the optional tests

Clone the upstream repository and copy the corpus into this directory:

```sh
git clone https://github.com/cabo/cddlc.git /tmp/cddlc
cp -r /tmp/cddlc/data /tmp/cddlc/test src/cddl/test-vectors/cddlc/
```

Then run:

```sh
npm run test:cddl-corpus    # parse + format round-trip over data/ and test/
npm run test:cddl-vectors   # embedded ;;+ / ;;- validation vectors in test/
```

These tests are intentionally excluded from `npm run test`. The vectors
run with the `ok` feature enabled, mirroring the cddlc Rakefile
(`CDDLC_FEATURE_OK=ok,^notok`).

Some files are skiplisted in the test driver (see the `SKIP` table in
`cddl-validation-vectors.test.ts` for the authoritative list and reasons):

- `18-abnf.cddl`, `22*-det.cddl` — `.abnf` / `.det` are not implemented.
- `6-bigint.cddl` — cddlc's Ruby decoder normalizes tags 2/3 to plain
  integers, so its vectors expect untagged ints to match `#6.2`/`#6.3`;
  we match tagged items strictly per RFC 8610 §3.6.
- `15-default.cddl` — cddlc treats `.default` as annotation-only;
  RFC 8610 §3.8.6 says it implies `.ne`, which we follow.

## Cross-checking against cddlc (oracle)

With a Ruby toolchain available, the same corpus can be checked against the
upstream implementation, which is useful when a corpus file fails here and
the question is "who is wrong?":

```sh
cd /tmp/cddlc
for f in data/*.cddl test/*.cddl; do
  ruby -Ilib bin/cddlc -t json "$f" > /dev/null || echo "cddlc rejects: $f"
done
```

`cddlc -t json <file>` prints the parse tree, so it can also be used to
compare structural interpretations of individual constructs.

For validation questions, `cddlc` also has a validator preview
(`echo '<EDN>' | cddlc file.cddl -d-`), but it does not support groups
yet. The classic `cddl` gem (`gem install cddl`) is the more complete
validation oracle:

```sh
cddl file.cddl validate instance.cbor
```

(We used it to confirm socket semantics: an unplugged `$$name` matches
nothing, and a bare plugged socket is required-once — hence `* $$name`.)
