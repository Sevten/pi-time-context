# Changelog

## Unreleased

### Added

- `/time-config` without arguments now opens an interactive menu: pick interval or threshold presets (or a custom value) or change the time zone. Implemented as a single custom TUI component (like pi's built-in menus), so navigating between steps and back does not flash the editor. Non-UI modes keep the usage text.
- `/time-config` can now be used before the session anchor exists: `show` displays the pending configuration, and change actions write the config layer so the new policy is adopted at activation.

### Changed

- Configuration is now global only (`~/.pi/agent/pi-time-context.json`); project-level config files, the `-g`/`--global` flag, and the config-layer picker in the interactive menu were removed.

### Fixed



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
