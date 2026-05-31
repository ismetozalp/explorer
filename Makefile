PREFIX ?= /usr/share/cockpit
NAME = explorer
INSTALL_DIR = $(PREFIX)/$(NAME)
SYSCONF ?= /etc/cockpit/$(NAME)
VERSION := $(shell cat VERSION)
TAG := v$(VERSION)

# Release notes for `make publish`. Override on the command line, e.g.
#   make publish RELEASE_NOTES="Fix the thing"
# (the make-target.sh interactive action passes this from an editable prompt).
RELEASE_NOTES ?= Release $(VERSION)

FILES = manifest.json index.html README.md VERSION Makefile \
        css js actions screenshots

.PHONY: all install uninstall zip publish clean help version

all: help

help:
	@echo "explorer plugin — version $(VERSION)"
	@echo
	@echo "Targets:"
	@echo "  make install    Copy plugin to $(INSTALL_DIR) (use sudo)"
	@echo "  make uninstall  Remove plugin from $(INSTALL_DIR) (use sudo)"
	@echo "  make zip        Produce explorer-$(VERSION).zip"
	@echo "  make publish    Build the zip and publish it as GitHub release $(TAG)"
	@echo "  make version    Print current version"
	@echo "  make clean      Remove build artifacts"

version:
	@echo $(VERSION)

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
	@if gh release view "$(TAG)" >/dev/null 2>&1; then \
	  echo "Release $(TAG) already exists — uploading asset (clobber)"; \
	  gh release upload "$(TAG)" "explorer-$(VERSION).zip" --clobber; \
	else \
	  echo "Creating release $(TAG)"; \
	  gh release create "$(TAG)" "explorer-$(VERSION).zip" --title "explorer $(VERSION)" --notes "Release $(VERSION)"; \
	fi
	@echo "Published $(TAG) (explorer-$(VERSION).zip)"

# Build the zip and publish it as a GitHub release tagged $(TAG) (= v$(VERSION)),
# uploading explorer-$(VERSION).zip as the release asset. The repo is detected
# from the git "origin" remote by the gh CLI. Commit & push first so the tag
# points at your latest commit.
publish: zip
	@command -v gh >/dev/null 2>&1 || { echo "gh CLI not found — install it first."; exit 1; }
	@gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated — run: gh auth login"; exit 1; }
	@if gh release view "$(TAG)" >/dev/null 2>&1; then \
	  echo "Release $(TAG) already exists — uploading asset (clobber)"; \
	  gh release upload "$(TAG)" "explorer-$(VERSION).zip" --clobber; \
	  gh release edit "$(TAG)" --notes "$(RELEASE_NOTES)"; \
	else \
	  echo "Creating release $(TAG)"; \
	  gh release create "$(TAG)" "explorer-$(VERSION).zip" --title "explorer $(VERSION)" --notes "$(RELEASE_NOTES)"; \
	fi
	@echo "Published $(TAG) (explorer-$(VERSION).zip)"
	@rm -f "explorer-$(VERSION).zip"
	@echo "Removed local explorer-$(VERSION).zip"

clean:
	rm -f explorer-*.zip explorer-*.tar.gz
