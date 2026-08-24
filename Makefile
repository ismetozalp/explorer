PREFIX ?= /usr/share/cockpit
NAME = explorer
INSTALL_DIR = $(PREFIX)/$(NAME)
SYSCONF ?= /etc/cockpit/$(NAME)
VERSION := $(shell cat VERSION)
TAG := v$(VERSION)

# Release notes for `make publish`. Override on the command line, e.g.
#   make publish RELEASE_NOTES="Fix the thing"
# (the make-target.sh interactive action passes this from an editable prompt).
# Exported so the recipe can read it as $$RELEASE_NOTES and write it to a file
# verbatim — this keeps multi-line / quoted notes intact.
RELEASE_NOTES ?= Release $(VERSION)
export RELEASE_NOTES

# What ships. An explicit allowlist, not a sweep of the working directory, so a
# development artifact can never reach a user by having been left lying around.
# COVERAGE.html and coverage/ are deliberately absent: they describe how the
# plugin was tested, which is a fact about this repository and no business of an
# installed copy.
FILES = manifest.json index.html README.md VERSION Makefile \
        css js html actions screenshots

# Coverage is measured over the shipped browser sources only (js/**). tests/ is
# excluded because a test file's own coverage says nothing, and the e2e/smoke
# suites run in a real browser (via Playwright) where node's instrumentation
# cannot reach — so their reach is invisible here. See the note `make coverage`
# prints and the "What this number does not include" section of COVERAGE.html.
COVERAGE_ARGS = --experimental-test-coverage \
	--test-coverage-include='js/**' --test-coverage-exclude='tests/**'
# Floors, not targets: a shade under what the unit suite achieves today, so a
# change that leaves new code untested fails the run instead of quietly moving
# the number down. Keep in step with FLOORS in tests/coverage.mjs. Raise them
# when the real figures rise; never lower them to make a red run green.
COVERAGE_MIN = --test-coverage-lines=48 --test-coverage-branches=77 \
	--test-coverage-functions=33

.PHONY: all install uninstall zip publish clean help version test coverage release

all: help

help:
	@echo "explorer plugin — version $(VERSION)"
	@echo
	@echo "Targets:"
	@echo "  make install    Copy plugin to $(INSTALL_DIR) (use sudo)"
	@echo "  make uninstall  Remove plugin from $(INSTALL_DIR) (use sudo)"
	@echo "  make test       Run unit tests with a gated coverage report"
	@echo "  make coverage   Coverage report plus coverage/lcov.info + COVERAGE.html"
	@echo "  make zip        Produce explorer-$(VERSION).zip"
	@echo "  make publish    Build the zip and publish it as GitHub release $(TAG)"
	@echo "  make release    test + zip + commit COVERAGE.html + publish $(TAG)"
	@echo "  make version    Print current version"
	@echo "  make clean      Remove build artifacts"

version:
	@echo $(VERSION)

# Unit tests only (tests/*-unit.mjs) — pure node + vm, no browser. Each source is
# loaded into a vm with its real filename so node's coverage attributes to js/**;
# without that the include glob matches nothing and reports a false 100%. The
# COVERAGE_MIN floors gate the run: below them, this fails.
test:
	@node --test $(COVERAGE_ARGS) $(COVERAGE_MIN) tests/*-unit.mjs

# The same measurement, written down. coverage/lcov.info is the machine copy for
# editors and CI and is not committed; COVERAGE.html is the human one that is.
#
# Note the ordering: the report is only written if the run PASSED. A coverage
# figure recorded from a red suite describes code that does not work.
coverage:
	@mkdir -p coverage
	@node --test $(COVERAGE_ARGS) $(COVERAGE_MIN) \
		--test-reporter=spec --test-reporter-destination=stdout \
		--test-reporter=lcov --test-reporter-destination=coverage/lcov.info \
		tests/*-unit.mjs
	@node tests/coverage.mjs
	@echo ""
	@echo "Not counted: the e2e/smoke browser suites, ffmpeg (a subprocess),"
	@echo "markup and styles, and the tests themselves. See COVERAGE.html."

# Cut a release: prove it, build it, record what was proven, ship it.
#
# Tests first, so nothing is built from a red tree. Then the archive, so what
# ships is what was tested. Then the coverage report, committed, so the
# repository carries a record of what the release was measured at rather than a
# claim in a message. Then publish. Deliberately does NOT bump the version or
# create the tag — deciding a change is 3.2.0 is a judgement, not a recipe's job.
release: test zip coverage
	@if [ -n "$$(git status --porcelain -- COVERAGE.html)" ]; then \
	  echo "Committing the coverage report for $(VERSION)"; \
	  git add COVERAGE.html; \
	  git commit -q -m "Record coverage for $(VERSION)" \
	    -m "Written by \`make coverage\` from the run that gated this release."; \
	  git push -q origin HEAD; \
	else \
	  echo "Coverage report unchanged since the last commit"; \
	fi
	@$(MAKE) --no-print-directory publish
	@echo "Released $(TAG)"

install:
	@if [ "$$(id -u)" != "0" ]; then echo "install requires root (use sudo)"; exit 1; fi
	@if [ -d $(INSTALL_DIR) ]; then echo "Removing previous install at $(INSTALL_DIR)"; rm -rf $(INSTALL_DIR); fi
	install -d $(INSTALL_DIR)
	cp -r $(FILES) $(INSTALL_DIR)/
	@# Record the installed version (used by the self-update action's {oldVersion}).
	install -d $(SYSCONF)
	printf '%s\n' "$(VERSION)" > $(SYSCONF)/installed-version
	@# Note: the self-update action ships with the plugin (built-in, loaded from
	@# $(INSTALL_DIR)/actions/system-actions.json) so it always matches the
	@# installed version — we no longer seed it into $(SYSCONF)/actions.json.
	@echo
	@echo "Installed explorer $(VERSION) to $(INSTALL_DIR)"
	@echo "Restart Cockpit with: systemctl try-restart cockpit"
	@echo "Then reload Cockpit in the browser. Look under 'Tools → Explorer'."

uninstall:
	@if [ "$$(id -u)" != "0" ]; then echo "uninstall requires root (use sudo)"; exit 1; fi
	rm -rf $(INSTALL_DIR)
	@echo "Removed $(INSTALL_DIR)"
	@echo "Note: left $(SYSCONF) in place (contains your system actions). Remove it manually if desired."

zip:
	@tmp=$$(mktemp -d); \
	mkdir "$$tmp/explorer"; \
	cp -r $(FILES) "$$tmp/explorer/"; \
	rm -rf "$$tmp/explorer/COVERAGE.html" "$$tmp/explorer/coverage"; \
	if [ -e "$$tmp/explorer/COVERAGE.html" ] || [ -e "$$tmp/explorer/coverage" ]; then \
	  echo "refusing to ship the coverage report"; rm -rf "$$tmp"; exit 1; fi; \
	(cd "$$tmp" && zip -rq "explorer-$(VERSION).zip" explorer -x 'explorer/explorer-*.zip'); \
	mv "$$tmp/explorer-$(VERSION).zip" .; \
	rm -rf "$$tmp"; \
	echo "Wrote explorer-$(VERSION).zip"

# Build the zip and publish it as a GitHub release tagged $(TAG) (= v$(VERSION)),
# uploading explorer-$(VERSION).zip as the release asset. The repo is detected
# from the git "origin" remote by the gh CLI. Commit & push first so the tag
# points at your latest commit.
publish: zip
	@command -v gh >/dev/null 2>&1 || { echo "gh CLI not found — install it first."; exit 1; }
	@gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated — run: gh auth login"; exit 1; }
	@notes="$$(mktemp)"; trap 'rm -f "$$notes"' EXIT; \
	printf '%s\n' "$$RELEASE_NOTES" > "$$notes"; \
	if gh release view "$(TAG)" >/dev/null 2>&1; then \
	  echo "Release $(TAG) already exists — uploading asset (clobber)"; \
	  gh release upload "$(TAG)" "explorer-$(VERSION).zip" --clobber; \
	  gh release edit "$(TAG)" --notes-file "$$notes"; \
	else \
	  echo "Creating release $(TAG)"; \
	  gh release create "$(TAG)" "explorer-$(VERSION).zip" --title "explorer $(VERSION)" --notes-file "$$notes"; \
	fi
	@echo "Published $(TAG) (explorer-$(VERSION).zip)"
	@rm -f "explorer-$(VERSION).zip"
	@echo "Removed local explorer-$(VERSION).zip"

clean:
	rm -f explorer-*.zip explorer-*.tar.gz
