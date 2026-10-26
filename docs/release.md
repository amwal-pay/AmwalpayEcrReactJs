# Release and rollback

How `@amwalpay/ecr-js` and `@amwalpay/ecr-react` are versioned, built, rolled out to SIT and
production, and rolled back.

## Identity

| | |
|---|---|
| Packages | `@amwalpay/ecr-js` (Node.js SDK), `@amwalpay/ecr-react` (React bindings) |
| Version | `1.0.0-rc.1` (`EcrSdk.VERSION`; both `package.json` files must match) |
| Repository | `https://github.com/amwal-pay/AmwalpayEcrJs` (to be created) |
| Parity | `AmwalPay.Ecr` 1.0.2 (.NET), `amwalpay/ecr-php` 1.0.0-rc.1 |
| Artifacts | `dist/amwalpay-ecr-js-<version>.tgz`, `dist/amwalpay-ecr-react-<version>.tgz`, each with a `.sha256` |

Semantic versioning: a patch fixes behaviour without API changes; a minor adds API; a major removes
or changes API. Any change to what a result means (an outcome that becomes unknown, a decline that
becomes a failure) is called out under **Changed** in [CHANGELOG.md](../CHANGELOG.md), with the
action an integrator must take. Integrators pin an exact version (`"@amwalpay/ecr-js": "1.0.0-rc.1"`,
no `^` or `~`) and commit their lock file.

## Build

```powershell
npm ci
npm run build              # tsc: packages/ecr-js/dist, packages/ecr-react/dist
npm test                   # unit + integration (real TCP, real HTTP, child processes) + React tests
npm run check:secrets      # no keys or card numbers in the repository
npm run pack:artifacts     # dist/amwalpay-ecr-js-<version>.tgz, dist/amwalpay-ecr-react-<version>.tgz + .sha256
```

`npm run pack:artifacts` (`node tools/build-artifact.mjs`) refuses to run unless `EcrSdk.VERSION`
is a semantic version, both `package.json` versions equal it, and `CHANGELOG.md` has an entry for
it. It builds both packages and runs `npm pack` for each: the tarball holds `package.json`, the
compiled `dist/` (JavaScript, `.d.ts`, source maps) and the documents (for `@amwalpay/ecr-js`:
`README.md`, `docs/`, `CHANGELOG.md`, `SECURITY.md`, copied in by `tools/prepare-package.mjs`).
Tests, tools and examples are not in the artifacts. npm stamps every entry with a fixed date, so
the same sources produce the same archive contents.

## Roll out

1. **Review.** Code review and security review of the tagged commit (this repository, plus
   [parity.md](parity.md) deviations agreed with the POS team). CI green on Windows and Linux,
   Node 18.18, 20 and 22.
2. **Tag** `v1.0.0-rc.1`, build, and store both `.tgz` files and their `.sha256` with the release.
3. **SIT.** Install the stored tarballs (not a rebuild, not the source tree) into the example and
   into the SIT till: `npm install ./amwalpay-ecr-js-1.0.0-rc.1.tgz`, or a `file:` dependency as in
   `examples/package.json`. Check each file against its `.sha256` first. Run
   `npm run verify-artifact` in `examples/`: it must print the stored SHA-256 values and
   *OK: the example runs on the built artifacts*.
4. **SIT evidence**, for each row of the [compatibility matrix](compatibility.md#compatibility-matrix-for-sit),
   Wi-Fi and Web Service:
   - an approved sale, void and refund, and a declined sale;
   - a timeout or lost answer that ends as an unknown outcome, the terminal blocking the next sale,
     and `reconcile()` settling it with the same result the terminal shows;
   - busy: a second sale on the same terminal while one is running;
   - close receipt; inquiry by receipt and by reference;
   - the log of each, showing masked PAN only and the key only as `configured`.
   Attach it to POS-573.
5. **Release approval**, then publish the same packages to the registry as `1.0.0` after bumping
   `EcrSdk.VERSION`, both `package.json` files and the CHANGELOG from the RC (the RC itself is never
   relabelled).
6. **Production** pins `@amwalpay/ecr-js` and `@amwalpay/ecr-react` at `1.0.0` exactly.

## Roll back

1. **Reconcile first.** On every till, list `await session.pendingOutcomes()` and run
   `await session.reconcile()`; settle what remains with the terminal's report or Amwal before any
   payment is retried. A rollback never clears an unknown outcome.
2. Pin the last verified version in `package.json` and run `npm install`, or redeploy the previous
   build of the till (with its lock file).
3. To stop using the JavaScript path entirely, switch the till's terminal configuration back to the
   previous integration (or disable the ECR feature) in the till's own settings.
4. Keep the `stateDirectory` contents: the journal is the record of what was sent. The previous
   version of this package reads the same files (and so does `amwalpay/ecr-php` 1.0.0-rc.1: same
   file names and format, but their locks differ: never run both against one folder at the same
   time); a till that does not use either should keep them until every entry is settled.

## Definition of done (from the task)

| Item | State |
|---|---|
| Code review, security review | Pending (human) |
| CI/tests green | Local: green on Windows 11 / Node 22.13.0. CI workflow in `.github/workflows/ci.yml` |
| Package names, version, repository, support matrix, release/rollback instructions | This page, [compatibility.md](compatibility.md) |
| Exact artifacts consumed by the example and verified in SIT | Example: done (`npm run verify-artifact`). SIT: pending |
| Integration guide and API reference published and linked from the task | Written ([integration-guide.md](integration-guide.md), [api-reference.md](api-reference.md)); publishing and linking: pending |
| Manual settlement | Blocked on POS-599; not in this release |
