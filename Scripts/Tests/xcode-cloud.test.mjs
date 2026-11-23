import { strict as assert } from "node:assert";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desiredChanges, main } from "../xcode-cloud.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const credential = privateKey.export({ type: "pkcs8", format: "pem" });
Object.assign(process.env, {
    XCODE_CLOUD_WORKFLOW_ID: "workflow-id",
    APP_STORE_CONNECT_ISSUER_ID: "issuer-id",
    APP_STORE_CONNECT_KEY_ID: "key-id",
    APP_STORE_CONNECT_PRIVATE_KEY: credential,
});

const archive = {
    name: "Archive iOS",
    actionType: "ARCHIVE",
    platform: "IOS",
    scheme: "NotificationManager",
    buildDistributionAudience: "APP_STORE_ELIGIBLE",
    isRequiredToPass: true,
};
const mainOnly = { source: { isAllMatch: false, patterns: [{ pattern: "main", isPrefix: false }] } };
// App Store Connect can include an empty patterns array for an all-branch condition.
const anyBranch = { source: { isAllMatch: true, patterns: [] } };
const automaticTag = { source: { isAllMatch: false, patterns: [{ pattern: "release-", isPrefix: true }] } };
const repository = {
    id: "repository-id", type: "scmRepositories",
    attributes: { ownerName: "ttakanawa", repositoryName: "punctual-ios" },
};
const buildLink = "https://api.appstoreconnect.apple.com/v1/ciBuildRuns/build-id";

function setEnv(context, name, value) {
    const original = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    context.after(() => {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
    });
}

function fixture(context, {
    branch = "main", repo = repository, manual = anyBranch, tags = null, enabled = true,
    settingsOk = true, validKey = true, refuseStart = false, exposeBranch = true, readbackManual,
    build = { id: "build-id", attributes: { number: 42 }, links: { self: buildLink } },
} = {}) {
    const workflow = {
        id: "workflow-id",
        attributes: {
            name: "The workflow identified by the existing Apple ID",
            actions: [archive], containerFilePath: "NotificationManager.xcodeproj",
            isEnabled: enabled,
            manualBranchStartCondition: manual,
            manualTagStartCondition: tags,
        },
        relationships: { repository: { data: { id: repo.id } } },
    };
    const calls = [];
    const githubCalls = [];
    const log = context.mock.method(console, "log", () => {});
    context.mock.method(globalThis, "fetch", async (url, request) => {
        if (url.origin === "https://api.github.com") {
            assert.ok(!request.headers.Authorization?.includes("issuer-id"));
            githubCalls.push(url.pathname);
            switch (url.pathname) {
            case "/repos/ttakanawa/punctual-ios/environments/appstore-connect":
                return Response.json({ deployment_branch_policy: {
                    custom_branch_policies: settingsOk, protected_branches: false,
                } });
            case "/repos/ttakanawa/punctual-ios/environments/appstore-connect/deployment-branch-policies":
                return Response.json({ total_count: 1, branch_policies: [{ type: "branch", name: "main" }] });
            default:
                assert.fail("Unexpected GitHub request " + url.pathname);
            }
        }
        assert.equal(url.origin, "https://api.appstoreconnect.apple.com");
        assert.equal(request.redirect, "error");
        const [header, claims, signature] = request.headers.Authorization.split(" ")[1].split(".");
        assert.equal(JSON.parse(Buffer.from(header, "base64url")).kid, "key-id");
        assert.equal(JSON.parse(Buffer.from(claims, "base64url")).iss, "issuer-id");
        assert.ok(verify("sha256", Buffer.from(header + "." + claims),
            { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
        const body = request.body ? JSON.parse(request.body).data : undefined;
        calls.push({ method: request.method, path: url.pathname, body });
        switch (url.pathname) {
        case "/v1/ciWorkflows/workflow-id":
            if (!validKey) {
                return Response.json({ errors: [{ code: "NOT_AUTHORIZED", detail: "Invalid token" }] }, { status: 401 });
            }
            if (request.method === "PATCH") {
                Object.assign(workflow.attributes, body.attributes);
                if (readbackManual) workflow.attributes.manualBranchStartCondition = readbackManual;
            }
            return Response.json({ data: workflow, included: [repo] });
        case "/v1/scmRepositories/repository-id/gitReferences":
            if (!url.searchParams.has("page")) {
                return Response.json({
                    data: [
                        { id: "tag-id", attributes: { canonicalName: "refs/tags/" + branch } },
                        { id: "deleted-id", attributes: { canonicalName: "refs/heads/" + branch, isDeleted: true } },
                    ],
                    links: { next: "/v1/scmRepositories/repository-id/gitReferences?limit=200&page=2" },
                });
            }
            return Response.json({
                data: [{
                    id: "branch-id",
                    attributes: { canonicalName: exposeBranch ? "refs/heads/" + branch : "refs/heads/unrelated", isDeleted: false },
                }],
            });
        case "/v1/ciBuildRuns":
            if (refuseStart) {
                return Response.json({ errors: [{ code: "STATE_ERROR", detail: "Branch cannot start workflow" }] }, { status: 409 });
            }
            return Response.json({ data: build }, { status: 201 });
        default:
            assert.fail("Unexpected Apple API request " + url.pathname);
        }
    });
    return { calls, githubCalls, log, workflow };
}

for (const branch of ["main", "feature/reminders"]) {
    test("start selects the existing canonical branch " + branch + " with only the repository credential", async (context) => {
        setEnv(context, "APP_STORE_CONNECT_ENV_PRIVATE_KEY", undefined);
        setEnv(context, "GITHUB_TOKEN", undefined);
        const directory = await mkdtemp(join(tmpdir(), "test-testflight-"));
        context.after(() => rm(directory, { recursive: true, force: true }));
        const summary = join(directory, "summary");
        setEnv(context, "GITHUB_STEP_SUMMARY", summary);
        const { calls, githubCalls, log } = fixture(context, { branch, settingsOk: false });
        await main("start", branch);
        assert.deepEqual(githubCalls, []);
        assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "GET", "POST"]);
        assert.deepEqual(calls.at(-1), {
            method: "POST", path: "/v1/ciBuildRuns",
            body: {
                type: "ciBuildRuns",
                relationships: {
                    workflow: { data: { type: "ciWorkflows", id: "workflow-id" } },
                    sourceBranchOrTag: { data: { type: "scmGitReferences", id: "branch-id" } },
                },
            },
        });
        const output = "Queued Xcode Cloud build 42 (build-id) for " + branch + ".\nBuild API resource: " + buildLink;
        assert.deepEqual(log.mock.calls[0].arguments, [output]);
        assert.equal(await readFile(summary, "utf8"), output + "\n");
    });
}

test("a start without a response link or number reports the build ID and finishes", async (context) => {
    setEnv(context, "GITHUB_STEP_SUMMARY", undefined);
    const { calls, log } = fixture(context, { build: { id: "build-id" } });
    await main("start", "main");
    assert.equal(calls.at(-1).method, "POST");
    assert.deepEqual(log.mock.calls[0].arguments, ["Queued Xcode Cloud build build-id for main."]);
});

test("a branch command uses the configured workflow ID and leaves start eligibility to Apple", async (context) => {
    const { calls, githubCalls } = fixture(context, { branch: "feature/reminders", manual: mainOnly, refuseStart: true });
    await assert.rejects(main("start", "feature/reminders"), /returned 409.*Branch cannot start workflow/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "GET", "POST"]);
    assert.deepEqual(githubCalls, []);
});

test("a same-name tag or deleted branch is never substituted for a missing branch", async (context) => {
    const { calls } = fixture(context, { exposeBranch: false });
    await assert.rejects(main("start", "main"), /cannot see the branch main/);
    assert.ok(calls.every(({ method }) => method === "GET"));
});

test("missing branch and missing repository key fail before calling Apple", async (context) => {
    setEnv(context, "APP_STORE_CONNECT_PRIVATE_KEY", undefined);
    const { calls } = fixture(context);
    await assert.rejects(main("start", ""), /Select a branch/);
    await assert.rejects(main("start", "main"), /Set APP_STORE_CONNECT_PRIVATE_KEY/);
    assert.deepEqual(calls, []);
});

test("an invalid App Store Connect credential never reaches the build request", async (context) => {
    const { calls } = fixture(context, { validKey: false });
    await assert.rejects(main("start", "main"), /GET .* returned 401/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
});

test("a disabled Apple workflow is rejected before listing branches", async (context) => {
    const { calls } = fixture(context, { enabled: false });
    await assert.rejects(main("start", "main"), /workflow is disabled/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
});

test("a successful API status without an Apple build ID is not reported as queued", async (context) => {
    const { log } = fixture(context, { build: {} });
    await assert.rejects(main("start", "main"), /did not return an Xcode Cloud build ID/);
    assert.deepEqual(log.mock.calls, []);
});

test("all-branch responses normalize only the empty match-all patterns", () => {
    const configuration = {
        project: "NotificationManager.xcodeproj", scheme: "NotificationManager", platform: "IOS", actionTypes: ["ARCHIVE"],
        startConditions: { manualBranchStartCondition: { source: { isAllMatch: true } } },
    };
    const workflow = { containerFilePath: configuration.project, actions: [archive] };
    const desired = configuration.startConditions;
    assert.deepEqual(desiredChanges({ ...workflow, manualBranchStartCondition: anyBranch }, configuration), {});
    assert.deepEqual(desiredChanges({ ...workflow, manualBranchStartCondition: mainOnly }, configuration), desired);
    const withPatterns = { source: { isAllMatch: true, patterns: [{ pattern: "main", isPrefix: false }] } };
    assert.deepEqual(desiredChanges({ ...workflow, manualBranchStartCondition: withPatterns }, configuration), desired);
});

test("configuration previews without writing and applies the settings for manual branches", async (context) => {
    const { calls, githubCalls, workflow } = fixture(context, { manual: mainOnly, tags: automaticTag });
    workflow.attributes.branchStartCondition = anyBranch;
    workflow.attributes.actions = [archive, { name: "Test iOS", actionType: "TEST" }];
    await main("plan");
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
    await main("apply");
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "PATCH", "GET"]);
    assert.deepEqual(calls[2].body.attributes, {
        actions: [archive], branchStartCondition: null,
        manualBranchStartCondition: { source: { isAllMatch: true } }, manualTagStartCondition: null,
    });
    assert.equal(githubCalls.length, 4);
    await main("apply");
    assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
});

test("configuration apply still verifies the environment and Apple readback", async (context) => {
    const { calls } = fixture(context, { manual: mainOnly, readbackManual: mainOnly });
    await assert.rejects(main("apply"), /still differs from the configuration/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "PATCH", "GET"]);
});

test("configuration apply blocks a non-main environment policy", async (context) => {
    const { calls } = fixture(context, { settingsOk: false });
    await assert.rejects(main("apply"), /Restrict the appstore-connect environment to the main branch/);
    assert.deepEqual(calls, []);
});

test("first-run plan prints local configuration without Apple credentials", async (context) => {
    setEnv(context, "APP_STORE_CONNECT_PRIVATE_KEY", undefined);
    const { calls, log } = fixture(context, { settingsOk: false });
    await main("plan");
    const output = log.mock.calls.flatMap(({ arguments: args }) => args).join("\n");
    assert.match(output, /Restrict the appstore-connect environment to the main branch/);
    assert.match(output, /APP_STORE_CONNECT_PRIVATE_KEY/);
    assert.match(output, /Desired Xcode Cloud configuration/);
    assert.deepEqual(calls, []);
});

test("a workflow connected to another repository can neither start nor be modified", async (context) => {
    const { calls } = fixture(context, {
        repo: { ...repository, attributes: { ownerName: "ttakanawa", repositoryName: "another-app" } },
    });
    await assert.rejects(main("start", "main"), /expected ttakanawa\/punctual-ios/);
    await assert.rejects(main("apply"), /expected ttakanawa\/punctual-ios/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET"]);
});
