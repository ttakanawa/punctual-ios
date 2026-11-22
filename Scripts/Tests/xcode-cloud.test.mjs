import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { desiredChanges, main } from "../xcode-cloud.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
Object.assign(process.env, {
    XCODE_CLOUD_WORKFLOW_ID: "workflow-id",
    APP_STORE_CONNECT_ISSUER_ID: "issuer-id",
    APP_STORE_CONNECT_KEY_ID: "key-id",
    APP_STORE_CONNECT_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
    GITHUB_ACTIONS_READ_TOKEN: "read-token",
    TESTFLIGHT_APP_TOKEN: "app-token",
    TESTFLIGHT_TAG_CREATION_RULESET_ID: "11",
    TESTFLIGHT_TAG_IMMUTABILITY_RULESET_ID: "12",
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
// GitHub Actions run 45034659968 before reconciliation.
const appleAnyBranch = { source: { isAllMatch: true, patterns: [] } };
const tagPrefix = "punctual-testflight-v1-";
const manualTag = { source: { isAllMatch: false, patterns: [{ pattern: tagPrefix, isPrefix: true }] } };
const repository = {
    id: "repository-id", type: "scmRepositories",
    attributes: { ownerName: "ttakanawa", repositoryName: "punctual-ios" },
};

const sha = "a".repeat(40);
const newerSha = "b".repeat(40);
const tag = `${tagPrefix}${sha}`;
const tagRef = `refs/tags/${tag}`;
const privateKeyName = "APP_STORE_CONNECT_ENV_PRIVATE_KEY";
const appKeyName = "TESTFLIGHT_APP_PRIVATE_KEY";
const trustedTree = [
    [".github/workflows/ci.yml", "100644"],
    ["ci_scripts/ci_post_clone.sh", "100755"],
    ["ci_scripts/require-ci.sh", "100644"],
].map(([path, mode]) => ({
    path, mode, type: "blob",
    sha: execFileSync("git", ["hash-object", path], { cwd: new URL("../../", import.meta.url), encoding: "utf8" }).trim(),
}));

async function fixture(context, {
    actions = [archive], manual = null, repo = repository, branch = "main", head = sha,
    resolved = sha, githubRef = `refs/heads/${branch}`, ciConclusion = "success", missingCI = false,
    tree = trustedTree, tagVisible = true, existingTag = null, branchMovesAfterTag = false,
    repositoryKeys = [], environmentKeys = [privateKeyName, appKeyName], secretStatus = 200,
    deploymentPolicies = [{ name: "main", type: "branch" }], rulesetOverride = {},
    workflowName = "TestFlight (verified tags)", readbackManual = null, cloudTagCondition = manualTag,
} = {}) {
    const workflow = {
        id: "workflow-id",
        attributes: {
            actions,
            containerFilePath: "NotificationManager.xcodeproj",
            isEnabled: true,
            name: workflowName,
            manualBranchStartCondition: manual,
            manualTagStartCondition: cloudTagCondition,
        },
        relationships: { repository: { data: { id: repo.id } } },
    };
    const branchRun = {
        head_sha: sha, head_branch: branch, event: branch === "main" ? "push" : "workflow_dispatch",
        head_repository: { full_name: "ttakanawa/punctual-ios" }, status: "completed",
        conclusion: ciConclusion, html_url: "https://github.com/ttakanawa/punctual-ios/actions/runs/1",
    };
    const directory = await mkdtemp(join(tmpdir(), "test-testflight-"));
    const previousPath = process.env.PATH;
    context.after(async () => {
        process.env.PATH = previousPath;
        await rm(directory, { recursive: true, force: true });
    });
    await writeFile(join(directory, "curl.response"), JSON.stringify({ workflow_runs: missingCI ? [] : [branchRun] }));
    await writeFile(join(directory, "curl"), [
        "#!/bin/sh",
        "set -eu",
        '[ -z "${APP_STORE_CONNECT_PRIVATE_KEY:-}" ]',
        '[ -z "${TESTFLIGHT_APP_TOKEN:-}" ]',
        '/bin/cat "$0.response"',
        "",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${directory}${delimiter}${previousPath}`;

    const calls = [];
    const refs = [];
    const tagWrites = [];
    let remoteHead = head;
    context.mock.method(globalThis, "fetch", async (url, request) => {
        if (url.origin === "https://api.github.com") {
            assert.equal(request.redirect, "error");
            const prefix = "/repos/ttakanawa/punctual-ios";
            assert.ok(url.pathname.startsWith(`${prefix}/`));
            const path = url.pathname.slice(prefix.length);
            const appRequest = ["/actions/secrets", "/environments/appstore-connect/secrets", "/git/refs"].includes(path);
            assert.equal(request.headers.Authorization, appRequest ? "Bearer app-token" : "Bearer read-token");
            if (path === `/git/ref/heads/${encodeURIComponent(branch)}`) {
                refs.push(remoteHead);
                return Response.json({
                    ref: githubRef, object: { type: "commit", sha: remoteHead },
                });
            }
            switch (path) {
            case `/git/trees/${sha}`:
                assert.equal(url.searchParams.get("recursive"), "1");
                return Response.json({ tree, truncated: false });
            case "/actions/secrets":
                return Response.json({ total_count: repositoryKeys.length, secrets: repositoryKeys.map((name) => ({ name })) },
                    { status: secretStatus });
            case "/environments/appstore-connect/secrets":
                return Response.json({ secrets: environmentKeys.map((name) => ({ name })) });
            case "/environments/appstore-connect/deployment-branch-policies":
                return Response.json({ total_count: deploymentPolicies.length, branch_policies: deploymentPolicies });
            case "/rulesets/11":
            case "/rulesets/12":
                return Response.json({
                    target: "tag", enforcement: "active",
                    conditions: { ref_name: { include: [`refs/tags/${tagPrefix}*`, `refs/tags/${tagPrefix}*/**/*`], exclude: [] } },
                    rules: (path.endsWith("11") ? ["creation"] : ["update", "deletion"]).map((type) => ({ type })),
                    ...rulesetOverride,
                });
            case `/git/ref/tags/${tag}`:
                return existingTag ? Response.json(existingTag) : new Response(null, { status: 404 });
            case "/git/refs": {
                assert.equal(request.method, "POST");
                const data = JSON.parse(request.body);
                tagWrites.push(data);
                return Response.json({ ref: data.ref, object: { type: "commit", sha: data.sha } }, { status: 201 });
            }
            default:
                assert.fail(`Unexpected GitHub request ${path}`);
            }
        }
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
            if (request.method === "PATCH") {
                Object.assign(workflow.attributes, body.attributes);
                workflow.attributes.manualBranchStartCondition = readbackManual;
            }
            return Response.json({ data: workflow, included: [repo] });
        case "/v1/scmRepositories/repository-id/gitReferences":
            if (branchMovesAfterTag) remoteHead = newerSha;
            if (!url.searchParams.has("page") && branch !== "main") {
                return Response.json({
                    data: [{ id: "deleted", attributes: { canonicalName: tagRef, isDeleted: true } }],
                    links: { next: "/v1/scmRepositories/repository-id/gitReferences?limit=200&page=2" },
                });
            }
            return Response.json({
                data: [
                    { id: "branch-id", attributes: { canonicalName: `refs/heads/${tag}`, isDeleted: false } },
                    { id: "tag-id", attributes: {
                        canonicalName: tagVisible ? tagRef : "refs/tags/unrelated",
                        ...(branch !== "main" && { isDeleted: false }),
                    } },
                ],
            });
        case "/v1/ciBuildRuns":
            assert.deepEqual(tagWrites.length ? tagWrites.at(-1) : { ref: existingTag?.ref, sha: existingTag?.object?.sha },
                { ref: tagRef, sha }, "Apple receives a tag pinned to the owner-supplied SHA");
            return Response.json({
                data: { id: "build-id", attributes: { number: 42, sourceCommit: { commitSha: resolved } } },
            }, { status: 201 });
        default:
            assert.fail(`Unexpected API request ${url.pathname}`);
        }
    });
    return { calls, refs, workflow, tagWrites, currentHead: () => remoteHead };
}

test("all-branch responses normalize only the empty match-all patterns", () => {
    const configuration = {
        project: "NotificationManager.xcodeproj", scheme: "NotificationManager", platform: "IOS", actionTypes: ["ARCHIVE"],
        startConditions: { manualBranchStartCondition: { source: { isAllMatch: true } } },
    };
    const workflow = { containerFilePath: configuration.project, actions: [archive] };
    const required = configuration.startConditions;
    assert.deepEqual(desiredChanges({ ...workflow, manualBranchStartCondition: appleAnyBranch }, configuration), {});
    assert.deepEqual(desiredChanges({ ...workflow, manualBranchStartCondition: manualMain }, configuration), required);
    assert.deepEqual(desiredChanges({ ...workflow, manualBranchStartCondition: {
        source: { isAllMatch: true, patterns: [{ pattern: "main", isPrefix: false }] },
    } }, configuration), required);
    const explicitEmpty = { ...configuration, startConditions: {
        manualBranchStartCondition: { source: { isAllMatch: false, patterns: [] } },
    } };
    assert.deepEqual(desiredChanges({ ...workflow, manualBranchStartCondition: { source: { isAllMatch: false } } },
        explicitEmpty), explicitEmpty.startConditions);
});

test("plan is read-only and apply removes the real all-branch condition", async (context) => {
    const { calls, workflow } = await fixture(context, {
        actions: [archive, testAction], manual: appleAnyBranch, cloudTagCondition: null,
    });
    workflow.attributes.branchStartCondition = appleAnyBranch;
    await main("plan");
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
    await main("apply");
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET", "PATCH", "GET"]);
    assert.deepEqual(calls[2].body.attributes, {
        actions: [archive], branchStartCondition: null, manualBranchStartCondition: null, manualTagStartCondition: manualTag,
    });
    await main("apply");
    assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
});

test("apply rejects a readback that still permits all branches", async (context) => {
    const { calls } = await fixture(context, { manual: appleAnyBranch, readbackManual: appleAnyBranch });
    await assert.rejects(main("apply"), /still differs from the configuration/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "PATCH", "GET"]);
});

test("dispatch refuses the real all-branch condition before creating a tag", async (context) => {
    const { calls, tagWrites } = await fixture(context, { manual: appleAnyBranch });
    await assert.rejects(main("start", "main", sha), /Apply the Xcode Cloud configuration/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
    assert.deepEqual(tagWrites, []);
});

for (const branch of ["main", "feature/reminders"]) {
    test(`start checks CI and queues the owner's ${branch} SHA by its Apple tag ID`, async (context) => {
        const { calls, refs, tagWrites, currentHead } = await fixture(context, { branch, branchMovesAfterTag: true });
        await main("start", branch, sha);
        assert.deepEqual(refs, [sha]);
        assert.equal(currentHead(), newerSha);
        assert.deepEqual(tagWrites, [{ ref: tagRef, sha }]);
        assert.deepEqual(calls.at(-1), {
            method: "POST",
            path: "/v1/ciBuildRuns",
            body: {
                type: "ciBuildRuns",
                relationships: {
                    workflow: { data: { type: "ciWorkflows", id: "workflow-id" } },
                    sourceBranchOrTag: { data: { type: "scmGitReferences", id: "tag-id" } },
                },
            },
        });
    });
}

test("wrong GitHub ref and invalid branch names never reach Apple", async (context) => {
    const { calls, refs } = await fixture(context, { githubRef: "refs/tags/main" });
    await assert.rejects(main("start", "main\necho unexpected", sha), /Enter a repository branch name/);
    await assert.rejects(main("start", "main", "main"), /full lowercase commit SHA/);
    assert.equal(refs.length, 0);
    await assert.rejects(main("start", "main", sha), /did not return a commit for refs\/heads\/main/);
    assert.deepEqual(calls, []);
});

test("an older branch or non-executable archive hook is rejected before contacting Apple", async (context) => {
    const branch = "feature/reminders";
    const tree = trustedTree.map((entry) =>
        entry.path === "ci_scripts/ci_post_clone.sh" ? { ...entry, mode: "100644" } : entry);
    const { calls } = await fixture(context, { branch, tree });
    await assert.rejects(main("start", branch, sha), /must adopt ci_scripts\/ci_post_clone\.sh from main/);
    assert.deepEqual(calls, []);
});

for (const options of [{ ciConclusion: "failure" }, { missingCI: true }]) {
    test(`${options.missingCI ? "missing" : "failed"} CI stops dispatch`, async (context) => {
        const branch = "feature/reminders";
        const { calls, tagWrites } = await fixture(context, { branch, ...options });
        await assert.rejects(main("start", branch, sha), /CI \(workflow_dispatch\) must pass on feature\/reminders/);
        assert.deepEqual(calls, []);
        assert.deepEqual(tagWrites, []);
    });
}

test("a missing Apple tag cannot be replaced by a branch with the same name", async (context) => {
    const { calls } = await fixture(context, { branch: "feature/reminders", tagVisible: false });
    await assert.rejects(main("start", "feature/reminders", sha), /cannot see the deployment tag/);
    assert.ok(calls.every(({ method }) => method === "GET"));
});

test("branch movement while GitHub is queued cannot select the new head", async (context) => {
    const { calls, refs, tagWrites } = await fixture(context, { branch: "feature/reminders", head: newerSha });
    await assert.rejects(main("start", "feature/reminders", sha), /is no longer at a{40}/);
    assert.deepEqual(refs, [newerSha]);
    assert.deepEqual(calls, []);
    assert.deepEqual(tagWrites, []);
});

test("an existing exact tag can be retried when the queued SHA is not yet reported", async (context) => {
    const { calls, tagWrites } = await fixture(context, { resolved: null,
        existingTag: { ref: tagRef, object: { type: "commit", sha } },
    });
    await main("start", "main", sha);
    assert.deepEqual(tagWrites, []);
    assert.equal(calls.at(-1).method, "POST");
});

test("an existing tag pointing at a different commit is never queued or rewritten", async (context) => {
    const { calls, tagWrites } = await fixture(context, { existingTag: { ref: tagRef, object: { type: "commit", sha: newerSha } } });
    await assert.rejects(main("start", "main", sha), /does not point directly/);
    assert.deepEqual(tagWrites, []);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
});

test("Apple reporting a different commit identifies the build for investigation", async (context) => {
    const { calls } = await fixture(context, { resolved: newerSha });
    await assert.rejects(main("start", "main", sha), /build build-id reported.*expected/);
    assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
});

for (const [options, error] of [
    [{ repositoryKeys: ["APP_STORE_CONNECT_PRIVATE_KEY"] }, /Remove .* repository secrets/],
    [{ repositoryKeys: [privateKeyName] }, /Remove .* repository secrets/],
    [{ environmentKeys: [appKeyName] }, /Store both private keys/],
    [{ secretStatus: 403 }, /actions\/secrets.*failed \(HTTP 403\)/],
    [{ deploymentPolicies: [{ name: "main", type: "tag" }] }, /environment to the main branch/],
    [{ rulesetOverride: { enforcement: "disabled" } }, /must actively enforce creation/],
    [{ rulesetOverride: { conditions: { ref_name: { include: [`refs/tags/${tagPrefix}*`], exclude: [] } } } },
        /full deployment tag namespace/],
]) {
    test(`deployment preflight fails closed for ${JSON.stringify(options)}`, async (context) => {
        const { calls, tagWrites } = await fixture(context, options);
        await assert.rejects(main("plan"), error);
        await assert.rejects(main("apply"), error);
        await assert.rejects(main("start", "main", sha), error);
        assert.deepEqual(calls, []);
        assert.deepEqual(tagWrites, []);
    });
}

test("a legacy workflow is rejected before any write", async (context) => {
    const { calls } = await fixture(context, { workflowName: "TestFlight", manual: appleAnyBranch });
    await assert.rejects(main("apply"), /Select the dedicated/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
});

test("an unrelated Cloud workflow is never changed", async (context) => {
    const { calls } = await fixture(context, {
        repo: { ...repository, attributes: { ownerName: "ttakanawa", repositoryName: "another-app" } },
    });
    await assert.rejects(main("apply"), /expected ttakanawa\/punctual-ios/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
});
