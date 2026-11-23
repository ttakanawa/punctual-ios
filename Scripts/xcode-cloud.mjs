import { sign } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const api = new URL("https://api.appstoreconnect.apple.com");
const configurationFile = new URL("../infra/xcode-cloud/testflight.json", import.meta.url);
const appleSettings = [
    "XCODE_CLOUD_WORKFLOW_ID", "APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_ID", "APP_STORE_CONNECT_PRIVATE_KEY",
];

function env(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Set ${name} for the App Store Connect request.`);
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

async function github(repository, path) {
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

async function start(workflow, repository, branch) {
    const ref = `refs/heads/${branch}`;
    let nextPage = `/v1/scmRepositories/${encodeURIComponent(repository.id)}/gitReferences?limit=200`;
    while (nextPage) {
        const page = await request(nextPage);
        const source = page.data.find(({ attributes }) =>
            attributes.canonicalName === ref && !attributes.isDeleted);
        if (source) {
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
            if (!build?.id) throw new Error("App Store Connect did not return an Xcode Cloud build ID.");
            return build;
        }
        nextPage = page.links?.next;
    }
    throw new Error(`Xcode Cloud cannot see the branch ${branch}. Verify that it exists and wait for it to appear in Xcode Cloud.`);
}

export async function main(operation, branch) {
    if (!["plan", "apply", "start"].includes(operation)) {
        throw new Error("Usage: node Scripts/xcode-cloud.mjs plan|apply or start <branch>");
    }
    if (operation === "start" && !branch) throw new Error("Select a branch in the Run workflow menu.");

    const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
    if (operation === "plan") {
        try {
            await verifyEnvironment(configuration.repository);
        } catch (error) {
            console.log(`Setup required: ${error.message}`);
        }
        const missing = appleSettings.filter((name) => !process.env[name]);
        if (missing.length) {
            console.log(`Set the App Store Connect inputs for the configuration workflow: ${missing.join(", ")}.`);
            console.log(`Desired Xcode Cloud configuration:\n${JSON.stringify(configuration, null, 2)}`);
            return;
        }
    } else if (operation === "apply") {
        await verifyEnvironment(configuration.repository);
    }

    const id = env("XCODE_CLOUD_WORKFLOW_ID");
    const path = `/v1/ciWorkflows/${encodeURIComponent(id)}`;
    const { data: workflow, included } = await request(`${path}?include=repository`);
    const repository = included?.find((entry) =>
        entry.type === "scmRepositories" && entry.id === workflow.relationships?.repository?.data?.id);
    const appleSlug = `${repository?.attributes.ownerName}/${repository?.attributes.repositoryName}`;
    if (appleSlug.toLowerCase() !== configuration.repository.toLowerCase()) {
        throw new Error(`Workflow repository is ${appleSlug}; expected ${configuration.repository}.`);
    }

    if (operation === "start") {
        if (!workflow.attributes.isEnabled) throw new Error("The configured Xcode Cloud workflow is disabled.");
        const build = await start(workflow, repository, branch);
        const number = build.attributes?.number;
        const label = number == null ? build.id : `${number} (${build.id})`;
        const summary = [`Queued Xcode Cloud build ${label} for ${branch}.`];
        if (build.links?.self) summary.push(`Build API resource: ${build.links.self}`);
        const output = summary.join("\n");
        console.log(output);
        if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${output}\n`);
        return;
    }

    const changes = desiredChanges(workflow.attributes, configuration);
    const changedFields = Object.keys(changes);
    if (!changedFields.length) {
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
    main(process.argv[2], process.argv[3]).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
