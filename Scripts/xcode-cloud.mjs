import { execFile } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const api = new URL("https://api.appstoreconnect.apple.com");
const configurationFile = new URL("../infra/xcode-cloud/testflight.json", import.meta.url);
const requireCI = new URL("../ci_scripts/require-ci.sh", import.meta.url);
const exec = promisify(execFile);
const appleSettings = [
    "XCODE_CLOUD_WORKFLOW_ID", "APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_ID", "APP_STORE_CONNECT_ENV_PRIVATE_KEY",
];

function env(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Set ${name} in the appstore-connect GitHub environment.`);
    return value;
}

function token() {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "ES256", kid: env("APP_STORE_CONNECT_KEY_ID"), typ: "JWT" };
    const claims = {
        iss: env("APP_STORE_CONNECT_ISSUER_ID"),
        iat: now,
        exp: now + 120,
        aud: "appstoreconnect-v1",
    };
    const unsigned = [header, claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
    const signature = sign("sha256", Buffer.from(unsigned), {
        key: env("APP_STORE_CONNECT_ENV_PRIVATE_KEY"),
        dsaEncoding: "ieee-p1363",
    });
    return `${unsigned}.${signature.toString("base64url")}`;
}

async function request(path, { method = "GET", data } = {}) {
    const url = new URL(path, api);
    if (url.origin !== api.origin) throw new Error("Unexpected App Store Connect API origin.");
    const response = await fetch(url, {
        method,
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token()}`,
            "Content-Type": "application/json",
        },
        body: data ? JSON.stringify({ data }) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        const detail = problem.errors?.map(({ code, detail }) => `${code}: ${detail}`).join("; ");
        throw new Error(`${method} ${url.pathname} returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response.json();
}

function normalizeCondition(condition) {
    if (!condition) return condition;
    const normalized = { ...condition };
    for (const field of ["source", "target"]) {
        const match = condition[field];
        if (match?.isAllMatch === true && Array.isArray(match.patterns) && match.patterns.length === 0) {
            const { patterns, ...rest } = match;
            normalized[field] = rest;
        }
    }
    return normalized;
}

export function desiredChanges(current, configuration) {
    if (current.containerFilePath !== configuration.project) {
        throw new Error(`Expected Xcode project ${configuration.project}, got ${current.containerFilePath}.`);
    }
    const archive = current.actions.filter((action) => action.actionType === "ARCHIVE");
    if (archive.length !== 1 || archive[0].scheme !== configuration.scheme ||
        archive[0].platform !== configuration.platform || !archive[0].isRequiredToPass) {
        throw new Error("Expected one required Archive action for the configured scheme and platform.");
    }
    if (!configuration.actionTypes.includes("ARCHIVE")) {
        throw new Error("The distribution workflow must retain the Archive action.");
    }
    const desired = {
        actions: current.actions.filter((action) => configuration.actionTypes.includes(action.actionType)),
        ...configuration.startConditions,
    };
    return Object.fromEntries(Object.entries(desired).filter(([name, value]) => {
        const actual = current[name] ?? null;
        if (name === "actions") return !isDeepStrictEqual(actual, value);
        return !isDeepStrictEqual(normalizeCondition(actual), normalizeCondition(value));
    }));
}

async function github(repository, path, { allowMissing } = {}) {
    const accessToken = process.env.GITHUB_TOKEN;
    const response = await fetch(new URL(`https://api.github.com/repos/${repository}/${path}`), {
        headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub request for ${path} failed (HTTP ${response.status}).`);
    return response.json();
}

async function verifyEnvironment(repository) {
    const [environment, policies] = await Promise.all([
        github(repository, "environments/appstore-connect"),
        github(repository, "environments/appstore-connect/deployment-branch-policies"),
    ]);
    if (environment.deployment_branch_policy?.custom_branch_policies !== true ||
        environment.deployment_branch_policy?.protected_branches !== false ||
        policies.total_count !== 1 || policies.branch_policies?.length !== 1 ||
        policies.branch_policies[0]?.name !== "main" || policies.branch_policies[0]?.type !== "branch") {
        throw new Error("Restrict the appstore-connect environment to the main branch.");
    }
}

async function verifyTagRules({ repository, deploymentTagPrefix }) {
    const patterns = [`refs/tags/${deploymentTagPrefix}*`, `refs/tags/${deploymentTagPrefix}*/**/*`];
    const id = process.env.TESTFLIGHT_TAG_IMMUTABILITY_RULESET_ID;
    if (!/^[0-9]+$/.test(id ?? "")) {
        throw new Error("Set the repository variable TESTFLIGHT_TAG_IMMUTABILITY_RULESET_ID to the GitHub ruleset ID.");
    }
    const ruleset = await github(repository, `rulesets/${id}`);
    const match = ruleset.conditions?.ref_name;
    const rules = ruleset.rules?.map(({ type }) => type) ?? [];
    if (ruleset.target !== "tag" || ruleset.enforcement !== "active" ||
        !isDeepStrictEqual(match?.exclude, []) || !patterns.every((pattern) => match?.include?.includes(pattern)) ||
        !rules.includes("update") || !rules.includes("deletion")) {
        throw new Error(`Ruleset ${id} must actively restrict updates and deletions on the full deployment tag namespace.`);
    }
    if (rules.includes("creation") || (ruleset.bypass_actors !== undefined && !isDeepStrictEqual(ruleset.bypass_actors, []))) {
        throw new Error(`Ruleset ${id} must allow tag creation and have an empty bypass list.`);
    }
}

async function branchHead(repository, branch) {
    const ref = await github(repository, `git/ref/heads/${encodeURIComponent(branch)}`);
    const sha = ref.object?.sha;
    if (ref.ref !== `refs/heads/${branch}` || ref.object?.type !== "commit" ||
        typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(`GitHub did not return a commit for refs/heads/${branch}.`);
    }
    return sha;
}

async function verifyBranch(repository, branch, sha) {
    try {
        await exec("git", ["check-ref-format", `refs/heads/${branch ?? ""}`], { env: { PATH: process.env.PATH } });
    } catch {
        throw new Error("Enter a repository branch name, such as main or feature/reminders.");
    }
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error("Enter the full lowercase commit SHA from the passing CI run.");
    }
    if (await branchHead(repository, branch) !== sha) {
        throw movedBranch(branch, sha);
    }
}

function movedBranch(branch, sha) {
    return new Error(`${branch} is no longer at ${sha}. Check CI on the current head and dispatch again.`);
}

async function verifySourceTree(repository, branch, sha) {
    const { tree, truncated } = await github(repository, `git/trees/${sha}?recursive=1`);
    if (truncated) throw new Error(`GitHub returned an incomplete tree for ${sha}.`);

    // The selected commit must carry the same CI workflow and archive gate as trusted main.
    const requiredFiles = {
        ".github/workflows/ci.yml": "100644",
        "ci_scripts/ci_post_clone.sh": "100755",
        "ci_scripts/require-ci.sh": "100644",
    };
    for (const [path, mode] of Object.entries(requiredFiles)) {
        const contents = await readFile(new URL(`../${path}`, import.meta.url));
        const blob = createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex");
        const entry = tree.find((file) => file.path === path);
        if (entry?.type !== "blob" || entry.mode !== mode || entry.sha !== blob) {
            throw new Error(`${branch} must adopt ${path} from main before TestFlight.`);
        }
    }
}

async function verifyCI(branch, sha) {
    try {
        const { stdout } = await exec("sh", [fileURLToPath(requireCI), branch, sha], {
            env: { PATH: process.env.PATH, GITHUB_ACTIONS_READ_TOKEN: process.env.GITHUB_TOKEN },
        });
        console.log(stdout.trim());
    } catch (error) {
        throw new Error(error.stderr?.trim() || `Could not verify CI on ${branch} at ${sha}.`);
    }
}

async function readDeploymentTag(repository, tag, sha) {
    const ref = `refs/tags/${tag}`;
    const pinned = await github(repository, `git/ref/tags/${tag}`, { allowMissing: true });
    if (pinned && (pinned.ref !== ref || pinned.object?.type !== "commit" || pinned.object.sha !== sha)) {
        throw new Error(`${ref} does not point directly to ${sha}.`);
    }
    return pinned;
}

async function ensureDeploymentTag(repository, branch, tag, sha) {
    if (await readDeploymentTag(repository, tag, sha)) return;

    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("Tag creation requires the GitHub Actions token with contents: write.");
    const remote = `https://github.com/${repository}.git`;
    const gitEnv = {
        PATH: process.env.PATH,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    };
    // Fetch only the existing branch tip. Never check out or run the selected branch on this runner.
    await exec("git", ["fetch", "--no-tags", "--depth=1", remote, `refs/heads/${branch}`], { env: gitEnv });
    const { stdout } = await exec("git", ["rev-parse", "--verify", "FETCH_HEAD"], { env: { PATH: process.env.PATH } });
    if (stdout.trim() !== sha) throw movedBranch(branch, sha);

    const ref = `refs/tags/${tag}`;
    // The empty lease requires an absent ref even if another writer creates the tag after our read.
    await exec("git", ["push", "--no-follow-tags", `--force-with-lease=${ref}:`, remote, `${sha}:${ref}`], { env: gitEnv });
    if (!await readDeploymentTag(repository, tag, sha)) throw new Error(`GitHub did not return ${ref} after creation.`);
}

async function start(workflow, repository, tag, { githubRepository, branch, sha }) {
    let nextPage = `/v1/scmRepositories/${encodeURIComponent(repository.id)}/gitReferences?limit=200`;
    while (nextPage) {
        const page = await request(nextPage);
        const source = page.data.find(({ attributes }) =>
            attributes.canonicalName === `refs/tags/${tag}` && !attributes.isDeleted);
        if (!source) {
            nextPage = page.links?.next;
            continue;
        }
        // Reruns can reuse the completed tag job. Check CI and the branch again before every Apple POST.
        await verifyCI(branch, sha);
        await verifyBranch(githubRepository, branch, sha);
        const { data: build } = await request("/v1/ciBuildRuns", {
            method: "POST",
            data: {
                type: "ciBuildRuns",
                relationships: {
                    workflow: { data: { type: "ciWorkflows", id: workflow.id } },
                    sourceBranchOrTag: { data: { type: "scmGitReferences", id: source.id } },
                },
            },
        });
        const resolved = build.attributes?.sourceCommit?.commitSha;
        if (resolved && resolved !== sha) {
            throw new Error(`Xcode Cloud build ${build.id} reported ${resolved} for ${tag}; expected ${sha}. ` +
                "Check the queued build in Xcode Cloud.");
        }
        return build;
    }
    throw new Error(`Xcode Cloud cannot see the deployment tag ${tag} yet. Wait for it to appear and dispatch again.`);
}

export async function main(operation, branch, sha) {
    if (!["plan", "apply", "tag", "start"].includes(operation)) {
        throw new Error("Usage: node Scripts/xcode-cloud.mjs plan|apply or tag|start <branch> <commit SHA>");
    }
    const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
    const { repository: slug, deploymentTagPrefix } = configuration;
    const tag = `${deploymentTagPrefix}${sha}`;
    if (operation === "tag" || operation === "start") await verifyBranch(slug, branch, sha);

    if (operation === "plan") {
        for (const check of [() => verifyEnvironment(slug), () => verifyTagRules(configuration)]) {
            try {
                await check();
            } catch (error) {
                console.log(`Setup required: ${error.message}`);
            }
        }
        console.log("In GitHub Settings, verify the empty tag ruleset bypass list and the environment-only Apple key.");
        const missing = appleSettings.filter((name) => !process.env[name]);
        if (missing.length) {
            console.log(`Set ${missing.join(", ")} in the appstore-connect GitHub environment for an Apple readback.`);
            console.log(`Desired Xcode Cloud configuration:\n${JSON.stringify(configuration, null, 2)}`);
            return;
        }
    } else {
        await verifyEnvironment(slug);
        await verifyTagRules(configuration);
    }

    if (operation === "tag") {
        await verifySourceTree(slug, branch, sha);
        await verifyCI(branch, sha);
        await ensureDeploymentTag(slug, branch, tag, sha);
        console.log(`Pinned ${branch} at ${sha} via ${tag}.`);
        return;
    }
    if (operation === "start" && !await readDeploymentTag(slug, tag, sha)) {
        throw new Error(`GitHub does not have the deployment tag ${tag}.`);
    }

    const id = env("XCODE_CLOUD_WORKFLOW_ID");
    const path = `/v1/ciWorkflows/${encodeURIComponent(id)}`;
    const { data: workflow, included } = await request(`${path}?include=repository`);
    const repository = included?.find((entry) =>
        entry.type === "scmRepositories" && entry.id === workflow.relationships?.repository?.data?.id);
    const appleSlug = `${repository?.attributes.ownerName}/${repository?.attributes.repositoryName}`;
    if (appleSlug.toLowerCase() !== slug.toLowerCase()) {
        throw new Error(`Workflow repository is ${appleSlug}; expected ${slug}.`);
    }
    if (workflow.attributes.name !== configuration.workflowName) {
        throw new Error(`Select the dedicated ${configuration.workflowName} workflow in XCODE_CLOUD_WORKFLOW_ID.`);
    }

    const changes = desiredChanges(workflow.attributes, configuration);
    const changedFields = Object.keys(changes);
    if (operation === "start") {
        if (changedFields.length) {
            throw new Error("Apply the Xcode Cloud configuration before starting TestFlight.");
        }
        if (!workflow.attributes.isEnabled) throw new Error("The configured Xcode Cloud workflow is disabled.");
        const build = await start(workflow, repository, tag, { githubRepository: slug, branch, sha });
        const summary = `Queued Xcode Cloud build ${build.attributes?.number ?? build.id} (${build.id}) for ${branch} via ${tag}.\n`;
        console.log(summary.trim());
        if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    } else if (!changedFields.length) {
        console.log("Xcode Cloud matches the configuration.");
    } else {
        const before = Object.fromEntries(changedFields.map((name) => [name, workflow.attributes[name] ?? null]));
        console.log(JSON.stringify({ before, after: changes }, null, 2));
        if (operation === "apply") {
            await request(path, { method: "PATCH", data: { type: "ciWorkflows", id, attributes: changes } });
            const { data: updated } = await request(path);
            if (Object.keys(desiredChanges(updated.attributes, configuration)).length) {
                throw new Error("The updated workflow still differs from the configuration.");
            }
            console.log("Updated the Xcode Cloud workflow.");
        }
    }
}

if (import.meta.main) {
    main(process.argv[2], process.argv[3], process.argv[4]).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
