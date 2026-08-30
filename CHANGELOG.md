# Changelog

## Unreleased

- Add an opt-in `showInjectedTime` notification for user-visible injected timestamps.

## [Unreleased]

### Added

- Initial deterministic time-context extension implementation.
- Continuous integration for type checking, tests, and package validation.
- MIT license file and configuration trust tests.

### Changed

- Resolve the project configuration directory through Pi's `CONFIG_DIR_NAME`.
- Warn about unknown configuration fields and avoid redundant file existence checks.
- Use portable local-install paths in the documentation.
- Prevent superseded provider request timings from leaking into later turns.
- Avoid rebuilding recovered session state when entries and the active branch are unchanged.
- Validate the package on both Node.js 22.19 and Node.js 24 in CI.

### Security

- Ignore project-local configuration while Pi project trust is inactive.
