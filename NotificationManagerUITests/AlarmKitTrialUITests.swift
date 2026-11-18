import XCTest

final class AlarmKitTrialUITests: XCTestCase {
    @MainActor
    func testTrialScreenUsesJapaneseLabelsWithoutStartingAnAlarm() throws {
        try requireAlarmKit()
        let app = launch(language: "ja", locale: "ja_JP")
        openTrial(in: app)

        let message = app.textFields["alarmkit-trial.message"]
        let defaultMessage = "通知時刻です"
        let start = app.buttons["alarmkit-trial.start"]
        XCTAssertEqual(message.value as? String, defaultMessage)
        XCTAssertTrue(start.isEnabled)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "alarmkit-trial-japanese"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        clearTrialMessage(message)
        XCTAssertTrue(start.wait(for: \.isEnabled, toEqual: false, timeout: 3))
    }

    @MainActor
    func testNativeCountdownSurvivesNavigationAndCanBeCancelled() throws {
        try requireAlarmKit()
        let app = launch(language: "en", locale: "en_GB")
        openTrial(in: app)
        defer { stopTrial(in: app) }
        startTrial(in: app, duration: "180 seconds")
        let countdown = NSPredicate(format: "label == 'Countdown is running.'")
        expectation(for: countdown, evaluatedWith: app.staticTexts["alarmkit-trial.native-phase"])
        waitForExpectations(timeout: 5)

        app.navigationBars.buttons.firstMatch.tap()
        openTrial(in: app)
        XCTAssertEqual(
            app.textFields["alarmkit-trial.message"].value as? String, "AlarmKit offline trial")
        XCTAssertTrue(app.buttons["alarmkit-trial.cancel"].isEnabled)
        stopTrial(in: app)
        XCTAssertEqual(
            app.staticTexts["alarmkit-trial.status"].label, "Test timer stopped.")
        XCTAssertFalse(app.buttons["alarmkit-trial.cancel"].isEnabled)
    }

    @MainActor
    func testNativeAlarmReachesAlertingAfterAppTermination() throws {
        try requireAlarmKit()
        #if targetEnvironment(simulator)
            // iOS 26.5 Simulator currently aborts in ToneLibrary/AVAudioSession.reporterID
            // when a named sound begins. Opt in only when investigating that runtime issue.
            try XCTSkipUnless(
                ProcessInfo.processInfo.environment["RUN_ALARMKIT_SYSTEM_ALERT_TESTS"] == "1",
                "Named AlarmKit sounds crash this Simulator runtime; run this test on a device.")
        #endif
        let app = launch(language: "en", locale: "en_GB")
        defer {
            app.launch()
            openTrial(in: app)
            stopTrial(in: app)
        }
        openTrial(in: app)
        startTrial(in: app, duration: "10 seconds")

        app.terminate()
        XCUIDevice.shared.press(.home)
        // Verify the real system state, independently of the app process. This does
        // not assert the system alert's layout, audio, or vibration.
        Thread.sleep(forTimeInterval: 12)
        app.launch()
        openTrial(in: app)
        let phase = app.staticTexts["alarmkit-trial.native-phase"]
        let alerting = NSPredicate(format: "label == 'The alarm time has arrived.'")
        expectation(for: alerting, evaluatedWith: phase)
        waitForExpectations(timeout: 5)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "alarmkit-native-alerting-after-app-termination"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private func requireAlarmKit() throws {
        guard #available(iOS 26.0, *) else {
            throw XCTSkip("AlarmKit requires iOS 26 or later.")
        }
    }

    @MainActor
    private func stopTrial(in app: XCUIApplication) {
        let cancel = app.buttons["alarmkit-trial.cancel"]
        if cancel.isEnabled { tapTrialAction(cancel) }
    }

    @MainActor
    private func startTrial(in app: XCUIApplication, duration: String) {
        let message = app.textFields["alarmkit-trial.message"]
        clearTrialMessage(message)
        message.typeText("AlarmKit offline trial")
        XCTAssertEqual(message.value as? String, "AlarmKit offline trial")
        if app.keyboards.buttons["Return"].exists { app.keyboards.buttons["Return"].tap() }

        app.buttons["alarmkit-trial.duration"].tap()
        let durationOption = app.buttons[duration]
        durationOption.tap()
        XCTAssertTrue(durationOption.waitForNonExistence(timeout: 5))
        let start = app.buttons["alarmkit-trial.start"]
        XCTAssertTrue(start.wait(for: \.isEnabled, toEqual: true, timeout: 5))
        tapTrialAction(start)

        // The simulator's system language can differ from the app's test language.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons.matching(
            NSPredicate(format: "label == 'Allow' OR label == '許可'")
        ).firstMatch
        if allow.waitForExistence(timeout: 8) { allow.tap() }
        let status = app.staticTexts["alarmkit-trial.status"]
        let scheduled = NSPredicate(format: "label == 'Timer scheduled. Close the app to test it.'")
        expectation(for: scheduled, evaluatedWith: status)
        waitForExpectations(timeout: 10)
    }

    @MainActor
    private func clearTrialMessage(_ field: XCUIElement) {
        let initial = field.value as? String ?? ""
        // Place the caret after the current message before sending backspaces.
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: initial.count))
    }

    @MainActor
    private func tapTrialAction(_ button: XCUIElement) {
        // Tap the leading label within the full-width form row on iPad.
        button.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.5)).tap()
    }

    @MainActor
    private func openTrial(in app: XCUIApplication) {
        XCTAssertTrue(app.otherElements["settings.root"].waitForExistence(timeout: 3))
        let link = app.buttons["settings.alarmkit-trial"]
        for _ in 0..<6 where !link.isHittable { app.swipeUp() }
        XCTAssertTrue(link.waitForExistence(timeout: 2))
        link.tap()
        XCTAssertTrue(app.textFields["alarmkit-trial.message"].waitForExistence(timeout: 2))
    }

    @MainActor
    private func launch(language: String, locale: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ui-testing", "-ui-scenario", "settings",
            "-AppleLanguages", "(\(language))", "-AppleLocale", locale
        ]
        app.launch()
        XCTAssertTrue(app.otherElements["settings.root"].waitForExistence(timeout: 3))
        return app
    }
}
