import { execFile } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const api = new URL("https://api.appstoreconnect.apple.com");
const configurationFile = new URL("../infra/xcode-cloud/testflight.json", import.meta.url);
const requireCI = new URL("../ci_scripts/require-ci.sh", import.meta.url);
const exec = promisify(execFile);

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
        key: env("APP_STORE_CONNECT_PRIVATE_KEY"),
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

async function github(repository, path, { accessToken = process.env.GITHUB_ACTIONS_READ_TOKEN, data, allowMissing } = {}) {
    const response = await fetch(new URL(`https://api.github.com/repos/${repository}/${path}`), {
        method: data ? "POST" : "GET",
        headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
            ...(data && { "Content-Type": "application/json" }),
        },
        body: data ? JSON.stringify(data) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub request for ${path} failed (HTTP ${response.status}).`);
    return response.json();
}

async function verifySecretScope(repository) {
    const accessToken = env("TESTFLIGHT_APP_TOKEN");
    const [repositorySecrets, environmentSecrets, policies] = await Promise.all([
        github(repository, "actions/secrets?per_page=100", { accessToken }),
        github(repository, "environments/appstore-connect/secrets?per_page=100", { accessToken }),
        github(repository, "environments/appstore-connect/deployment-branch-policies"),
    ]);
    if (policies.total_count !== 1 || policies.branch_policies?.length !== 1 ||
        policies.branch_policies[0]?.name !== "main" || policies.branch_policies[0]?.type !== "branch") {
        throw new Error("Restrict the appstore-connect environment to the main branch.");
    }
    const required = ["APP_STORE_CONNECT_ENV_PRIVATE_KEY", "TESTFLIGHT_APP_PRIVATE_KEY"];
    const prohibited = [...required, "APP_STORE_CONNECT_PRIVATE_KEY"];
    if (!Array.isArray(repositorySecrets.secrets) || repositorySecrets.secrets.length !== repositorySecrets.total_count ||
        repositorySecrets.secrets.some(({ name }) => prohibited.includes(name))) {
        throw new Error("Remove the App Store Connect and deployment App keys from repository secrets.");
    }
    if (!required.every((key) => environmentSecrets.secrets?.some(({ name }) => name === key))) {
        throw new Error("Store both private keys in the appstore-connect environment.");
    }
}

async function verifyTagRules({ repository, deploymentTagPrefix }) {
    const patterns = [`refs/tags/${deploymentTagPrefix}*`, `refs/tags/${deploymentTagPrefix}*/**/*`];
    const required = {
        TESTFLIGHT_TAG_CREATION_RULESET_ID: ["creation"],
        TESTFLIGHT_TAG_IMMUTABILITY_RULESET_ID: ["update", "deletion"],
    };
    for (const [variable, rules] of Object.entries(required)) {
        const id = env(variable);
        if (!/^[0-9]+$/.test(id)) throw new Error(`Set ${variable} to its GitHub ruleset ID.`);
        const ruleset = await github(repository, `rulesets/${id}`);
        const match = ruleset.conditions?.ref_name;
        if (ruleset.target !== "tag" || ruleset.enforcement !== "active" ||
            !isDeepStrictEqual(match?.exclude, []) || !patterns.every((pattern) => match?.include?.includes(pattern)) ||
            !rules.every((rule) => ruleset.rules?.some(({ type }) => type === rule))) {
            throw new Error(`Ruleset ${id} must actively enforce ${rules.join(" and ")} on the full deployment tag namespace.`);
        }
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

async function verifySource(repository, branch, sha) {
    const shellEnv = { PATH: process.env.PATH };
    try {
        await exec("git", ["check-ref-format", `refs/heads/${branch ?? ""}`], { env: shellEnv });
    } catch {
        throw new Error("Enter a repository branch name, such as main or feature/reminders.");
    }
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error("Enter the full lowercase commit SHA from the passing CI run.");
    }
    if (await branchHead(repository, branch) !== sha) {
        throw new Error(`${branch} is no longer at ${sha}. Check CI on the current head and dispatch again.`);
    }
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

    try {
        const { stdout } = await exec("sh", [fileURLToPath(requireCI), branch, sha], {
            env: { ...shellEnv, GITHUB_ACTIONS_READ_TOKEN: process.env.GITHUB_ACTIONS_READ_TOKEN },
        });
        console.log(stdout.trim());
    } catch (error) {
        throw new Error(error.stderr?.trim() || `Could not verify CI on ${branch} at ${sha}.`);
    }
}

async function ensureDeploymentTag(repository, tag, sha) {
    const ref = `refs/tags/${tag}`;
    const path = `git/ref/tags/${tag}`;
    const existing = await github(repository, path, { allowMissing: true });
    const pinned = existing ?? await github(repository, "git/refs", {
        accessToken: env("TESTFLIGHT_APP_TOKEN"),
        data: { ref, sha },
    });
    if (pinned.ref !== ref || pinned.object?.type !== "commit" || pinned.object.sha !== sha) {
        throw new Error(`${ref} does not point directly to ${sha}.`);
    }
}

async function start(workflow, repository, tag, sha) {
    let nextPage = `/v1/scmRepositories/${encodeURIComponent(repository.id)}/gitReferences?limit=200`;
    while (nextPage) {
        const page = await request(nextPage);
        const source = page.data.find(({ attributes }) =>
            attributes.canonicalName === `refs/tags/${tag}` && !attributes.isDeleted);
        if (!source) {
            nextPage = page.links?.next;
            continue;
        }
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
    if (!["plan", "apply", "start"].includes(operation)) {
        throw new Error("Usage: node Scripts/xcode-cloud.mjs plan|apply or start <branch> <commit SHA>");
    }
    const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
    if (operation === "start") await verifySource(configuration.repository, branch, sha);
    await verifySecretScope(configuration.repository);
    await verifyTagRules(configuration);
    const id = env("XCODE_CLOUD_WORKFLOW_ID");
    const path = `/v1/ciWorkflows/${encodeURIComponent(id)}`;
    const { data: workflow, included } = await request(`${path}?include=repository`);
    const repository = included?.find((entry) =>
        entry.type === "scmRepositories" && entry.id === workflow.relationships?.repository?.data?.id);
    const slug = `${repository?.attributes.ownerName}/${repository?.attributes.repositoryName}`;
    if (slug.toLowerCase() !== configuration.repository.toLowerCase()) {
        throw new Error(`Workflow repository is ${slug}; expected ${configuration.repository}.`);
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
        const tag = `${configuration.deploymentTagPrefix}${sha}`;
        await ensureDeploymentTag(configuration.repository, tag, sha);
        const build = await start(workflow, repository, tag, sha);
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
