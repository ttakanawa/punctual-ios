import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { desiredChanges, main } from "../xcode-cloud.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
Object.assign(process.env, {
    XCODE_CLOUD_WORKFLOW_ID: "workflow-id",
    APP_STORE_CONNECT_ISSUER_ID: "issuer-id",
    APP_STORE_CONNECT_KEY_ID: "key-id",
    APP_STORE_CONNECT_ENV_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
    GITHUB_TOKEN: "job-token",
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
const pinnedTag = { ref: tagRef, object: { type: "commit", sha } };
const remote = "https://github.com/ttakanawa/punctual-ios.git";
const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
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
    ciSHA = sha, ciFailsDuringDiscovery = false,
    tree = trustedTree, tagVisible = true, existingTag = null, branchMovesDuringDiscovery = false,
    fetchedHead = sha, pushStatus = 0, policyEnabled = true,
    deploymentPolicies = [{ name: "main", type: "branch" }], rulesetOverride = {}, rulesetStatus = 200,
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
        head_sha: ciSHA, head_branch: branch, event: branch === "main" ? "push" : "workflow_dispatch",
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
        '[ -z "${APP_STORE_CONNECT_ENV_PRIVATE_KEY:-}" ]',
        '[ -z "${GITHUB_TOKEN:-}" ]',
        '[ "$GITHUB_ACTIONS_READ_TOKEN" = job-token ]',
        `case " $* " in *' branch=${branch} '*"head_sha=${sha} "*) ;; *) exit 98 ;; esac`,
        'printf "%s\\n" "$*" >> "$0.calls"',
        '/bin/cat "$0.response"',
        "",
    ].join("\n"), { mode: 0o755 });
    const auth = Buffer.from("x-access-token:job-token").toString("base64");
    await writeFile(join(directory, "git"), [
        "#!/bin/sh",
        "set -eu",
        '[ -z "${APP_STORE_CONNECT_ENV_PRIVATE_KEY:-}" ]',
        'case "$1" in',
        `  fetch|push) [ "$GIT_CONFIG_VALUE_0" = 'Authorization: Basic ${auth}' ]`,
        '    [ "$GIT_CONFIG_KEY_0" = http.https://github.com/.extraheader ]',
        '    [ "$GIT_TERMINAL_PROMPT" = 0 ]',
        '    printf "%s\\n" "$*" >> "$0.calls"',
        `    if [ "$1" = push ]; then [ ${pushStatus} -eq 0 ] || exit ${pushStatus}; touch "$0.pushed"; fi ;;`,
        `  rev-parse) [ "$*" = 'rev-parse --verify FETCH_HEAD' ]; printf '%s\\n' '${fetchedHead}' ;;`,
        `  *) exec '${gitPath}' "$@" ;;`,
        "esac",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${directory}${delimiter}${previousPath}`;

    const calls = [];
    const refs = [];
    async function readCalls(command) {
        const log = await readFile(join(directory, `${command}.calls`), "utf8").catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return "";
        });
        return log.trim() ? log.trim().split("\n") : [];
    }
    async function remoteTag() {
        return existingTag ?? await readFile(join(directory, "git.pushed")).then(() => pinnedTag, () => null);
    }
    let remoteHead = head;
    context.mock.method(globalThis, "fetch", async (url, request) => {
        if (url.origin === "https://api.github.com") {
            assert.equal(request.redirect, "error");
            const prefix = "/repos/ttakanawa/punctual-ios";
            assert.ok(url.pathname.startsWith(`${prefix}/`));
            const path = url.pathname.slice(prefix.length);
            assert.equal(request.headers.Authorization, "Bearer job-token");
            assert.equal(request.method ?? "GET", "GET");
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
            case "/environments/appstore-connect":
                return Response.json({ deployment_branch_policy: { custom_branch_policies: policyEnabled, protected_branches: false } });
            case "/environments/appstore-connect/deployment-branch-policies":
                return Response.json({ total_count: deploymentPolicies.length, branch_policies: deploymentPolicies });
            case "/rulesets/12":
                return Response.json({
                    target: "tag", enforcement: "active",
                    conditions: { ref_name: { include: [`refs/tags/${tagPrefix}*`, `refs/tags/${tagPrefix}*/**/*`], exclude: [] } },
                    rules: [{ type: "update" }, { type: "deletion" }],
                    ...rulesetOverride,
                }, { status: rulesetStatus });
            case `/git/ref/tags/${tag}`: {
                const currentTag = await remoteTag();
                return currentTag ? Response.json(currentTag) : new Response(null, { status: 404 });
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
            if (branchMovesDuringDiscovery) remoteHead = newerSha;
            if (ciFailsDuringDiscovery) {
                await writeFile(join(directory, "curl.response"), JSON.stringify({
                    workflow_runs: [{ ...branchRun, conclusion: "failure" }],
                }));
            }
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
            assert.deepEqual(await remoteTag(), pinnedTag, "Apple receives a tag pinned to the owner-supplied SHA");
            assert.ok((await readCalls("curl")).length, "CI is queried before the Apple POST");
            return Response.json({
                data: { id: "build-id", attributes: { number: 42, sourceCommit: { commitSha: resolved } } },
            }, { status: 201 });
        default:
            assert.fail(`Unexpected API request ${url.pathname}`);
        }
    });
    return { calls, refs, workflow, gitCalls: () => readCalls("git"), ciCalls: () => readCalls("curl") };
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

test("dispatch refuses the real all-branch condition before starting Apple", async (context) => {
    const { calls, gitCalls } = await fixture(context, { manual: appleAnyBranch, existingTag: pinnedTag });
    await assert.rejects(main("start", "main", sha), /Apply the Xcode Cloud configuration/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
    assert.deepEqual(await gitCalls(), []);
});

for (const branch of ["main", "feature/reminders"]) {
    test(`start checks CI and queues the owner's ${branch} SHA by its Apple tag ID`, async (context) => {
        const { calls, refs, gitCalls, ciCalls } = await fixture(context, { branch });
        await main("tag", branch, sha);
        assert.deepEqual(calls, [], "the write-token job never contacts Apple");
        await main("start", branch, sha);
        assert.deepEqual(refs, [sha, sha, sha]);
        assert.equal((await ciCalls()).length, 2);
        assert.deepEqual(await gitCalls(), [
            "fetch --no-tags --depth=1 " + remote + " refs/heads/" + branch,
            "push --no-follow-tags --force-with-lease=" + tagRef + ": " + remote + " " + sha + ":" + tagRef,
        ]);
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
    await assert.rejects(main("tag", branch, sha), /must adopt ci_scripts\/ci_post_clone\.sh from main/);
    assert.deepEqual(calls, []);
});

for (const [name, options] of [["failed", { ciConclusion: "failure" }], ["missing", { missingCI: true }],
    ["different SHA", { ciSHA: newerSha }]]) {
    test(`${name} CI stops tagging`, async (context) => {
        const branch = "feature/reminders";
        const { calls, gitCalls } = await fixture(context, { branch, ...options });
        await assert.rejects(main("tag", branch, sha), /CI \(workflow_dispatch\) must pass on feature\/reminders/);
        assert.deepEqual(calls, []);
        assert.deepEqual(await gitCalls(), []);
    });
}

test("a missing Apple tag cannot be replaced by a branch with the same name", async (context) => {
    const { calls } = await fixture(context, { branch: "feature/reminders", tagVisible: false, existingTag: pinnedTag });
    await assert.rejects(main("start", "feature/reminders", sha), /cannot see the deployment tag/);
    assert.ok(calls.every(({ method }) => method === "GET"));
});

test("branch movement while GitHub is queued cannot select the new head", async (context) => {
    const { calls, refs, gitCalls } = await fixture(context, { branch: "feature/reminders", head: newerSha });
    await assert.rejects(main("tag", "feature/reminders", sha), /is no longer at a{40}/);
    assert.deepEqual(refs, [newerSha]);
    assert.deepEqual(calls, []);
    assert.deepEqual(await gitCalls(), []);
});

test("branch movement between the GitHub read and fetch prevents the tag push", async (context) => {
    const { calls, gitCalls } = await fixture(context, { fetchedHead: newerSha });
    await assert.rejects(main("tag", "main", sha), /no longer at/);
    assert.deepEqual(await gitCalls(), ["fetch --no-tags --depth=1 " + remote + " refs/heads/main"]);
    assert.deepEqual(calls, []);
});

test("branch movement during Apple tag discovery stops even a retry", async (context) => {
    const { calls, refs } = await fixture(context, { branchMovesDuringDiscovery: true, existingTag: pinnedTag });
    await assert.rejects(main("start", "main", sha), /no longer at/);
    assert.deepEqual(refs, [sha, newerSha]);
    assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET"]);
});

test("an existing exact tag can be retried when the queued SHA is not yet reported", async (context) => {
    const { calls, gitCalls, ciCalls } = await fixture(context, { resolved: null, existingTag: pinnedTag });
    await main("tag", "main", sha);
    await main("start", "main", sha);
    assert.deepEqual(await gitCalls(), []);
    assert.equal((await ciCalls()).length, 2);
    assert.equal(calls.at(-1).method, "POST");
});

test("GitHub dispatch verifies current exact CI before reusing a protected tag", async (context) => {
    const branch = "feature/reminders";
    const { calls, gitCalls, ciCalls } = await fixture(context, { branch, ciFailsDuringDiscovery: true, existingTag: pinnedTag });
    await main("tag", branch, sha);
    await assert.rejects(main("start", branch, sha), /CI \(workflow_dispatch\) must pass on feature\/reminders/);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(({ method }) => method === "GET"));
    assert.deepEqual(await gitCalls(), []);
    assert.equal((await ciCalls()).length, 2);
});

for (const object of [{ type: "commit", sha: newerSha }, { type: "tag", sha }]) {
    test(`an existing ${object.type} ref without a direct match is never queued or rewritten`, async (context) => {
        const { calls, gitCalls } = await fixture(context, { existingTag: { ref: tagRef, object } });
        await assert.rejects(main("tag", "main", sha), /does not point directly/);
        await assert.rejects(main("start", "main", sha), /does not point directly/);
        assert.deepEqual(await gitCalls(), []);
        assert.deepEqual(calls, []);
    });
}

test("a rejected tag push fails closed and is never retried as an update", async (context) => {
    const { calls, gitCalls } = await fixture(context, { pushStatus: 1 });
    await assert.rejects(main("tag", "main", sha), /git push/);
    await assert.rejects(main("start", "main", sha), /GitHub does not have the deployment tag/);
    assert.equal((await gitCalls()).filter((call) => call.startsWith("push ")).length, 1);
    assert.deepEqual(calls, []);
});

test("Apple reporting a different commit identifies the build for investigation", async (context) => {
    const { calls } = await fixture(context, { resolved: newerSha, existingTag: pinnedTag });
    await assert.rejects(main("start", "main", sha), /build build-id reported.*expected/);
    assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
});

for (const [options, error] of [
    [{ rulesetStatus: 404 }, /rulesets\/12.*failed \(HTTP 404\)/],
    [{ policyEnabled: false }, /environment to the main branch/],
    [{ deploymentPolicies: [{ name: "main", type: "tag" }] }, /environment to the main branch/],
    [{ rulesetOverride: { enforcement: "disabled" } }, /actively restrict updates and deletions/],
    [{ rulesetOverride: { rules: [{ type: "update" }] } }, /actively restrict updates and deletions/],
    [{ rulesetOverride: { rules: [{ type: "deletion" }] } }, /actively restrict updates and deletions/],
    [{ rulesetOverride: { rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }] } }, /must allow tag creation/],
    [{ rulesetOverride: { bypass_actors: [{ actor_type: "RepositoryRole" }] } }, /empty bypass list/],
    [{ rulesetOverride: { conditions: { ref_name: { include: [`refs/tags/${tagPrefix}*`], exclude: [] } } } },
        /full deployment tag namespace/],
]) {
    test(`deployment preflight fails closed for ${JSON.stringify(options)}`, async (context) => {
        const { calls, gitCalls } = await fixture(context, options);
        await assert.rejects(main("apply"), error);
        await assert.rejects(main("tag", "main", sha), error);
        await assert.rejects(main("start", "main", sha), error);
        assert.deepEqual(calls, []);
        assert.deepEqual(await gitCalls(), []);
    });
}

test("first-run plan prints setup gaps and local configuration with no ruleset or Apple key", async (context) => {
    const { calls, gitCalls } = await fixture(context, { policyEnabled: false });
    for (const name of ["APP_STORE_CONNECT_ENV_PRIVATE_KEY", "TESTFLIGHT_TAG_IMMUTABILITY_RULESET_ID"]) {
        const value = process.env[name];
        context.after(() => { process.env[name] = value; });
        delete process.env[name];
    }
    const log = context.mock.method(console, "log", () => {});
    await main("plan");
    const output = log.mock.calls.flatMap(({ arguments: args }) => args).join("\n");
    assert.match(output, /Restrict the appstore-connect environment to the main branch/);
    assert.match(output, /Set the repository variable TESTFLIGHT_TAG_IMMUTABILITY_RULESET_ID/);
    assert.match(output, /Set APP_STORE_CONNECT_ENV_PRIVATE_KEY/);
    assert.match(output, /Desired Xcode Cloud configuration.*\n.*\n.*repository/);
    assert.deepEqual(calls, []);
    assert.deepEqual(await gitCalls(), []);
});

test("plan can preview Apple changes before the ruleset is configured", async (context) => {
    const { calls, gitCalls } = await fixture(context, { rulesetStatus: 404, manual: appleAnyBranch });
    const log = context.mock.method(console, "log", () => {});
    await main("plan");
    const output = log.mock.calls.flatMap(({ arguments: args }) => args).join("\n");
    assert.match(output, /Setup required.*rulesets\/12/);
    assert.match(output, /"manualBranchStartCondition": null/);
    assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
    assert.deepEqual(await gitCalls(), []);
});

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
