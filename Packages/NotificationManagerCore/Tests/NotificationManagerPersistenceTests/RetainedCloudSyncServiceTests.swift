import Testing

@testable import NotificationManagerPersistence

@Suite struct RetainedCloudSyncServiceTests {
    @Test func engineOperationDoesNotInheritDelegateContext() async {
        let observation = CallbackContextObservation()
        let (operation, callerContext) = SimulatedEngineCallback.$isActive.withValue(true) {
            let operation = RetainedCloudSyncService.runOutsideEngineCallback {
                await observation.record(SimulatedEngineCallback.isActive)
            }
            return (operation, SimulatedEngineCallback.isActive)
        }

        // Wait after returning from the simulated delegate, as production callbacks must.
        await operation.value

        #expect(callerContext)
        #expect(!SimulatedEngineCallback.isActive)
        #expect(await observation.values == [false])
    }

    @Test func deferredEngineOperationEscapesContextInheritedByRegularTask() async {
        let observation = CallbackContextObservation()
        let deferred = SimulatedEngineCallback.$isActive.withValue(true) {
            Task {
                let operation = RetainedCloudSyncService.runOutsideEngineCallback {
                    await observation.record(SimulatedEngineCallback.isActive)
                }
                return (operation, SimulatedEngineCallback.isActive)
            }
        }

        let (operation, inheritedContext) = await deferred.value
        await operation.value

        #expect(inheritedContext)
        #expect(!SimulatedEngineCallback.isActive)
        #expect(await observation.values == [false])
    }
}

private enum SimulatedEngineCallback {
    @TaskLocal static var isActive = false
}

private actor CallbackContextObservation {
    private(set) var values: [Bool] = []

    func record(_ value: Bool) {
        values.append(value)
    }
}
