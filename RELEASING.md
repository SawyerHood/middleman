# Releasing

GitHub Actions publishes npm releases from [`.github/workflows/release.yml`](.github/workflows/release.yml). The workflow runs on pushes to tags matching `v*` and can also be started manually with `workflow_dispatch` by providing a version.

## Prerequisite

Set the `NPM_TOKEN` GitHub Actions secret with npm publish access before running a release.

## To Release

1. Bump version in `package.json` (root)
2. Run `pnpm build` to stage the npm package
3. Commit: `git commit -am "chore: release X.Y.Z"`
4. Tag: `git tag vX.Y.Z`
5. Push: `git push origin main --tags`
6. CI handles the rest (build, validate, publish to npm)

## Manual Fallback

If a tagged release needs a manual retry, run the `Release` workflow from GitHub Actions with the `version` input set to `vX.Y.Z` or `X.Y.Z`. The workflow verifies that the requested version matches the root `package.json` version before publishing.
