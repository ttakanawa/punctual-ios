import { strict as assert } from "node:assert";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { main } from "../xcode-cloud.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
Object.assign(process.env, {
    XCODE_CLOUD_WORKFLOW_ID: "workflow-id",
    APP_STORE_CONNECT_ISSUER_ID: "issuer-id",
    APP_STORE_CONNECT_KEY_ID: "key-id",
    APP_STORE_CONNECT_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const archive = {
    name: "Archive iOS",
    actionType: "ARCHIVE",
    platform: "IOS",
    scheme: "NotificationManager",
    buildDistributionAudience: "APP_STORE_ELIGIBLE",
    isRequiredToPass: true,
};
const testAction = { name: "Test iOS", actionType: "TEST" };
const manualMain = { source: { isAllMatch: false, patterns: [{ pattern: "main", isPrefix: false }] } };
const repository = {
    id: "repository-id", type: "scmRepositories",
    attributes: { ownerName: "ttakanawa", repositoryName: "punctual-ios" },
};

function fixture(context, { actions = [archive, testAction], repo = repository } = {}) {
    const workflow = {
        id: "workflow-id",
        attributes: {
            actions,
            containerFilePath: "NotificationManager.xcodeproj",
            isEnabled: true,
            manualBranchStartCondition: manualMain,
        },
        relationships: { repository: { data: { id: repo.id } } },
    };
    const calls = [];
    context.mock.method(globalThis, "fetch", async (url, request) => {
        const [header, claims, signature] = request.headers.Authorization.split(" ")[1].split(".");
        assert.equal(JSON.parse(Buffer.from(header, "base64url")).kid, "key-id");
        assert.equal(JSON.parse(Buffer.from(claims, "base64url")).iss, "issuer-id");
        assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`),
            { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
        assert.equal(url.origin, "https://api.appstoreconnect.apple.com");
        const body = request.body ? JSON.parse(request.body).data : undefined;
        calls.push({ method: request.method, path: url.pathname, body });
        switch (url.pathname) {
        case "/v1/ciWorkflows/workflow-id":
            if (request.method === "PATCH") Object.assign(workflow.attributes, body.attributes);
            return Response.json({ data: workflow, included: [repo] });
        case "/v1/scmRepositories/repository-id/gitReferences":
            return Response.json({
                data: [{ id: "main-id", attributes: { canonicalName: "refs/heads/main", isDeleted: false } }],
            });
        case "/v1/ciBuildRuns":
            return Response.json({ data: { id: "build-id", attributes: { number: 42 } } }, { status: 201 });
        default:
            assert.fail(`Unexpected API request ${url.pathname}`);
        }
    });
    return { calls, workflow };
}

test("plan is read-only and apply updates only the managed fields", async (context) => {
    const { calls, workflow } = fixture(context);
    workflow.attributes.branchStartCondition = { source: { isAllMatch: true } };
    workflow.attributes.manualBranchStartCondition = { source: { isAllMatch: true } };
    await main("plan");
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
    await main("apply");
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "PATCH", "GET"]);
    assert.deepEqual(calls[2].body.attributes, {
        actions: [archive], branchStartCondition: null, manualBranchStartCondition: manualMain,
    });
    await main("apply");
    assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
});

test("start requires the applied configuration and queues main", async (context) => {
    const { calls, workflow } = fixture(context);
    await assert.rejects(main("start"), /Apply the Xcode Cloud configuration/);
    workflow.attributes.actions = [archive];
    await main("start");
    assert.deepEqual(calls.at(-1), {
        method: "POST",
        path: "/v1/ciBuildRuns",
        body: {
            type: "ciBuildRuns",
            relationships: {
                workflow: { data: { type: "ciWorkflows", id: "workflow-id" } },
                sourceBranchOrTag: { data: { type: "scmGitReferences", id: "main-id" } },
            },
        },
    });
});

test("an unrelated Cloud workflow is never changed", async (context) => {
    const { calls } = fixture(context, {
        repo: { ...repository, attributes: { ownerName: "ttakanawa", repositoryName: "another-app" } },
    });
    await assert.rejects(main("apply"), /expected ttakanawa\/punctual-ios/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
});
