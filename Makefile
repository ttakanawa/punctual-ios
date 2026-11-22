.DEFAULT_GOAL := help

PROJECT := NotificationManager.xcodeproj
SCHEME := NotificationManager
SIMULATOR_NAME ?= iPhone 17
SIMULATOR_OS ?= latest
SIMULATOR_DESTINATION := platform=iOS Simulator,name=$(SIMULATOR_NAME),OS=$(SIMULATOR_OS)
TEST_RESULT_BUNDLE ?=
TEST_LOCALE := -testLanguage en -testRegion US

SWIFT_PATHS := \
	NotificationManager \
	NotificationManagerWidget \
	NotificationManagerTests \
	NotificationManagerIntegrationTests \
	NotificationManagerUITests \
	Packages/NotificationManagerCore/Package.swift \
	Packages/NotificationManagerCore/Sources \
	Packages/NotificationManagerCore/Tests \
	Scripts/validate-localizations.swift

LOCALIZATION_CATALOGS := \
	NotificationManager/Resources/InfoPlist.xcstrings \
	NotificationManager/Resources/Common.xcstrings \
	NotificationManager/Resources/ReminderForm.xcstrings \
	NotificationManager/Resources/Reminder.xcstrings \
	NotificationManager/Resources/NotificationText.xcstrings \
	NotificationManager/Resources/Settings.xcstrings \
	NotificationManager/Resources/Tags.xcstrings \
	NotificationManager/Resources/Recovery.xcstrings \
	NotificationManagerWidget/Resources/Widget.xcstrings

.PHONY: help format lint test ui-test test-unit test-integration test-ui build-release \
	validate-localizations test-localization-validator validate-testflight \
	test-package test-testflight-validator test-ci-scripts test-hooks pre-commit install-hooks

help:
	@echo "make format                       Format maintained Swift sources"
	@echo "make lint                         Check source style, localization and distribution settings"
	@echo "make test                         Run package, script, unit and integration tests"
	@echo "make ui-test                      Run Xcode UI tests"
	@echo "make test-unit                    Run package and Xcode unit tests"
	@echo "make test-integration             Run Xcode integration tests"
	@echo "make build-release                Build Release for iOS Simulator"
	@echo "make validate-localizations       Validate string catalogs and source coverage"
	@echo "make test-localization-validator  Test localization validator fixtures"
	@echo "make validate-testflight          Validate TestFlight configuration"
	@echo "make test-package                 Run core package tests"
	@echo "make test-testflight-validator     Test distribution build-number validation"
	@echo "make test-ci-scripts               Test Xcode Cloud hooks and TestFlight notes"
	@echo "make pre-commit                    Check staged Swift sources"
	@echo "make install-hooks                 Enable the Git hook for this worktree"

format:
	swift format --configuration .swift-format --in-place --recursive $(SWIFT_PATHS)

lint:
	bash Scripts/hooks/check-swift.sh $(SWIFT_PATHS)
	shellcheck .githooks/pre-commit Scripts/hooks/*.sh Scripts/Tests/git-hooks.sh \
		Scripts/Tests/xcode-cloud-hooks.sh ci_scripts/ci_post_clone.sh ci_scripts/require-main-ci.sh
	node --check Scripts/xcode-cloud.mjs
	$(MAKE) validate-localizations validate-testflight

test: test-package test-localization-validator test-testflight-validator test-ci-scripts test-hooks
	xcodebuild test -project $(PROJECT) -scheme $(SCHEME) \
		-destination '$(SIMULATOR_DESTINATION)' \
		-skip-testing:NotificationManagerUITests \
		$(TEST_LOCALE) $(if $(TEST_RESULT_BUNDLE),-resultBundlePath "$(TEST_RESULT_BUNDLE)")

pre-commit:
	bash Scripts/hooks/pre-commit.sh $(SWIFT_PATHS)

install-hooks:
	bash Scripts/hooks/install.sh

test-unit:
	$(MAKE) test-package
	xcodebuild test -project $(PROJECT) -scheme $(SCHEME) \
		-destination '$(SIMULATOR_DESTINATION)' $(TEST_LOCALE) \
		-only-testing:NotificationManagerTests

test-integration:
	xcodebuild test -project $(PROJECT) -scheme $(SCHEME) \
		-destination '$(SIMULATOR_DESTINATION)' $(TEST_LOCALE) \
		-only-testing:NotificationManagerIntegrationTests

ui-test:
	xcodebuild test -project $(PROJECT) -scheme $(SCHEME) \
		-destination '$(SIMULATOR_DESTINATION)' $(TEST_LOCALE) \
		-only-testing:NotificationManagerUITests

test-ui: ui-test

build-release:
	xcodebuild build -project $(PROJECT) -scheme $(SCHEME) \
		-configuration Release \
		-destination 'generic/platform=iOS Simulator' \
		CODE_SIGNING_ALLOWED=NO

validate-localizations:
	swift Scripts/validate-localizations.swift $(LOCALIZATION_CATALOGS) --source-root .

test-localization-validator:
	sh Scripts/Tests/validate-localization-source-coverage.sh

validate-testflight:
	sh Scripts/validate-testflight-configuration.sh

test-package:
	swift test --package-path Packages/NotificationManagerCore

test-testflight-validator:
	sh Scripts/Tests/validate-testflight-build-numbers.sh

test-ci-scripts:
	sh Scripts/Tests/xcode-cloud-hooks.sh
	sh Scripts/Tests/testflight-notes.sh
	node --test Scripts/Tests/xcode-cloud.test.mjs

test-hooks:
	bash Scripts/Tests/git-hooks.sh
